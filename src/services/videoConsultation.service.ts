import crypto from 'crypto';
import prisma from '../config/database';
import { Prisma } from '@prisma/client';
import webSocketManager from './websocketManager.service';
import firebaseService from './firebase.service';
import loggingService, { LogCategory, LogLevel } from './logging.service';
import {
  getTwilioClient,
  twilioConfig,
  buildVideoAccessToken,
  getAudioFallbackDetails,
  AudioFallbackDetails
} from '../config/twilio';

const VIDEO_DROP_THRESHOLD_MS = Number(process.env.VIDEO_DROP_THRESHOLD_MS ?? 120_000);

interface VideoRoomConfig {
  appointmentId?: string;
  conversationId: string;
  hostId: string;
  roomName?: string;
  recordingEnabled?: boolean;
  waitingRoomEnabled?: boolean;
  screenSharingEnabled?: boolean;
  chatEnabled?: boolean;
  maxParticipants?: number;
}

interface VideoRoomInfo {
  id: string;
  roomId: string;
  roomPassword?: string;
  roomName?: string;
  status: string;
  appointmentId?: string;
  conversationId: string;
  hostId: string;
  participantIds: string[];
  maxParticipants: number;
  recordingEnabled: boolean;
  recordingConsent: RecordingConsentMap;
  waitingRoomEnabled: boolean;
  screenSharingEnabled: boolean;
  chatEnabled: boolean;
  startedAt?: Date;
  endedAt?: Date;
  actualDuration?: number;
  joinUrl: string;
  hostJoinUrl: string;
  provider: 'twilio';
  twilioRoomSid?: string;
  kpi?: VideoRoomKpi;
}

interface JoinCredentials {
  roomId: string;
  accessToken: string;
  joinUrl: string;
  isHost: boolean;
  provider: 'twilio';
  expiresAt: Date;
  audioFallback: AudioFallbackDetails;
  roomConfig: {
    recordingEnabled: boolean;
    screenSharingEnabled: boolean;
    chatEnabled: boolean;
    waitingRoomEnabled: boolean;
    audioOnlyFallbackEnabled: boolean;
  };
}

interface RecordingInfo {
  id: string;
  recordingName?: string;
  duration?: number;
  fileSize?: number;
  status: string;
  recordingUrl?: string;
  thumbnailUrl?: string;
  transcriptUrl?: string;
  consentRecorded: boolean;
  accessLevel: string;
  createdAt: Date;
  providerRecordingSid?: string;
}

interface RecordingConsentEntry {
  consented: boolean;
  consentedAt: string;
}

type RecordingConsentMap = Record<string, RecordingConsentEntry>;
type RecordingConsentInput = Record<string, boolean | RecordingConsentEntry>;

interface VideoRoomKpi {
  averageJoinTimeMs?: number;
  dropRate?: number;
  audioFallbackCount: number;
  participantCount?: number;
}

class VideoConsultationService {

  /**
   * Create a new video room for consultation
   */
  async createVideoRoom(config: VideoRoomConfig): Promise<VideoRoomInfo | null> {
    try {
      if (!twilioConfig.isConfigured) {
        throw new Error('Twilio video provider is not configured.');
      }

      // Validate conversation access
      const conversation = await prisma.conversation.findUnique({
        where: { id: config.conversationId },
        include: {
          client: { select: { id: true, firstName: true, lastName: true } },
          lawyer: { select: { id: true, firstName: true, lastName: true } }
        }
      });

      if (!conversation) {
        throw new Error('Conversation not found');
      }

      // Verify host is a participant
      if (config.hostId !== conversation.clientId && config.hostId !== conversation.lawyerId) {
        throw new Error('Host must be a conversation participant');
      }

      // Generate unique room ID and password
      const roomId = this.generateRoomId();
      const roomPassword = this.generateRoomPassword();

      const twilioClient = getTwilioClient();
      const roomUniqueName = this.getTwilioRoomName(roomId, config.conversationId);
      const roomType = config.maxParticipants && config.maxParticipants > 4 ? 'group' : 'group-small';

      const twilioRoom = await twilioClient.video.v1.rooms.create({
        uniqueName: roomUniqueName,
        type: roomType as any,
        recordParticipantsOnConnect: Boolean(config.recordingEnabled),
        statusCallback: process.env.TWILIO_VIDEO_STATUS_CALLBACK_URL,
        mediaRegion: process.env.TWILIO_VIDEO_REGION,
        maxParticipants: config.maxParticipants ?? 2
      });

      // Prepare participant IDs
      const participantIds = [conversation.clientId, conversation.lawyerId];

      // Create video room record
      const videoRoom = await prisma.videoRoom.create({
        data: {
          appointmentId: config.appointmentId,
          conversationId: config.conversationId,
          roomName: config.roomName || `Consultation with ${conversation.client.firstName} ${conversation.client.lastName}`,
          roomId,
          roomPassword: this.encryptPassword(roomPassword),
          hostId: config.hostId,
          participantIds: participantIds,
          maxParticipants: config.maxParticipants || 2,
          recordingEnabled: config.recordingEnabled || false,
          recordingConsent: {},
          twilioRoomSid: twilioRoom.sid,
          waitingRoomEnabled: config.waitingRoomEnabled !== false,
          screenSharingEnabled: config.screenSharingEnabled !== false,
          chatEnabled: config.chatEnabled !== false,
          status: 'created',
          externalServiceData: {
            provider: 'twilio',
            roomUniqueName,
            roomType,
            mediaRegion: twilioRoom.mediaRegion,
            sid: twilioRoom.sid
          }
        } as Prisma.VideoRoomUncheckedCreateInput
      });

      // Generate join URLs
      const baseUrl = process.env.FRONTEND_URL || 'https://app.lawyerconsult.com';
      const joinUrl = `${baseUrl}/video/join/${roomId}`;
      const hostJoinUrl = `${baseUrl}/video/host/${roomId}`;

      // Log room creation
      await prisma.communicationAuditLog.create({
        data: {
          eventType: 'video_room_created',
          eventData: {
            roomId: videoRoom.id ?? undefined,
            appointmentId: config.appointmentId,
            conversationId: config.conversationId,
            recordingEnabled: config.recordingEnabled,
            provider: 'twilio',
            twilioRoomSid: twilioRoom.sid
          },
          initiatedBy: config.hostId,
          conversationId: config.conversationId,
          isPrivileged: true
        }
      });

  loggingService.log(LogLevel.INFO, LogCategory.EXTERNAL_SERVICE, 'Video room created', {
        roomId,
        conversationId: config.conversationId,
        provider: 'twilio',
        twilioRoomSid: twilioRoom.sid
      });

      const recordingConsent = this.deserializeConsent((videoRoom as any).recordingConsent);
      const twilioRoomSid = (videoRoom as any).twilioRoomSid as string | undefined;

      return {
        id: videoRoom.id ?? undefined,
        roomId,
        roomPassword,
        roomName: videoRoom.roomName ?? undefined,
        status: videoRoom.status ?? undefined,
        appointmentId: videoRoom.appointmentId ?? undefined,
        conversationId: videoRoom.conversationId ?? undefined,
        hostId: videoRoom.hostId ?? undefined,
        participantIds,
        maxParticipants: videoRoom.maxParticipants ?? undefined,
        recordingEnabled: videoRoom.recordingEnabled ?? undefined,
        recordingConsent,
        waitingRoomEnabled: videoRoom.waitingRoomEnabled ?? undefined,
        screenSharingEnabled: videoRoom.screenSharingEnabled ?? undefined,
        chatEnabled: videoRoom.chatEnabled ?? undefined,
        startedAt: videoRoom.startedAt ?? undefined,
        endedAt: videoRoom.endedAt ?? undefined,
        actualDuration: videoRoom.actualDuration ?? undefined,
        joinUrl,
        hostJoinUrl,
        provider: 'twilio',
        twilioRoomSid
      };

    } catch (error) {
  loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Failed to create video room', {
        error: error instanceof Error ? error.message : String(error),
        conversationId: config.conversationId
      });
      return null;
    }
  }

  /**
   * Get join credentials for a video room
   */
  async getJoinCredentials(roomId: string, userId: string): Promise<JoinCredentials | null> {
    try {
      if (!twilioConfig.isConfigured) {
        throw new Error('Twilio video provider is not configured');
      }

      const videoRoom = await prisma.videoRoom.findUnique({
        where: { roomId },
        include: {
          conversation: {
            select: {
              clientId: true,
              lawyerId: true
            }
          }
        }
      });

      if (!videoRoom) {
        throw new Error('Video room not found');
      }

      const conversation = videoRoom.conversation;
      if (userId !== conversation.clientId && userId !== conversation.lawyerId) {
        throw new Error('Access denied to video room');
      }

      if (videoRoom.status === 'expired' || videoRoom.status === 'ended') {
        throw new Error('Video room is no longer available');
      }

      const twilioRoomSid = (videoRoom as any).twilioRoomSid as string | undefined;
      if (!twilioRoomSid) {
        throw new Error('Twilio room not initialized for this consultation');
      }

      const roomUniqueName = this.getTwilioRoomName(roomId, videoRoom.conversationId);
      const { token: accessToken, expiresAt } = buildVideoAccessToken(userId, roomUniqueName);
      const audioFallback = getAudioFallbackDetails(userId);

      const isHost = userId === videoRoom.hostId;
      const baseUrl = process.env.FRONTEND_URL || 'https://app.lawyerconsult.com';
      const joinUrl = `${baseUrl}/video/join/${roomId}?token=${accessToken}`;

      const joinLatencyMs = videoRoom.startedAt ? Math.max(Date.now() - videoRoom.startedAt.getTime(), 0) : 0;
      await this.trackParticipantJoin(videoRoom.id, userId, joinLatencyMs, false);

      await prisma.communicationAuditLog.create({
        data: {
          eventType: 'video_room_accessed',
          eventData: {
            roomId: videoRoom.id ?? undefined,
            joinUrl,
            isHost,
            provider: 'twilio',
            audioFallbackEnabled: audioFallback.enabled
          },
          initiatedBy: userId,
          conversationId: videoRoom.conversationId ?? undefined,
          isPrivileged: true
        }
      });

      return {
        roomId,
        accessToken,
        joinUrl,
        isHost,
        provider: 'twilio',
        expiresAt,
        audioFallback,
        roomConfig: {
          recordingEnabled: Boolean(videoRoom.recordingEnabled),
          screenSharingEnabled: Boolean(videoRoom.screenSharingEnabled),
          chatEnabled: Boolean(videoRoom.chatEnabled),
          waitingRoomEnabled: Boolean(videoRoom.waitingRoomEnabled),
          audioOnlyFallbackEnabled: audioFallback.enabled
        }
      };

    } catch (error) {
      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Failed to get video join credentials', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
        userId
      });
      return null;
    }
  }

  /**
   * Start a video room session
   */
  async startVideoRoom(roomId: string, userId: string): Promise<boolean> {
    try {
      const videoRoom = await prisma.videoRoom.findUnique({
        where: { roomId },
        include: {
          conversation: {
            select: {
              clientId: true,
              lawyerId: true
            }
          }
        }
      });

      if (!videoRoom) {
        return false;
      }

      // Only host can start the room
      if (userId !== videoRoom.hostId) {
        throw new Error('Only the host can start the video room');
      }

      // Update room status
      await prisma.videoRoom.update({
        where: { roomId },
        data: {
          status: 'active',
          startedAt: new Date()
        }
      });

      await this.trackParticipantJoin(videoRoom.id, userId, 0, false);

      // Notify participants via WebSocket
      await webSocketManager.broadcastToRoom(
        videoRoom.conversationId,
        'video_room_started',
        {
          roomId,
          startedBy: userId,
          joinUrl: `${process.env.FRONTEND_URL}/video/join/${roomId}`,
          timestamp: new Date()
        }
      );

      // Send push notifications to participants
      const participants = [videoRoom.conversation.clientId, videoRoom.conversation.lawyerId];
      for (const participantId of participants) {
        if (participantId !== userId && !webSocketManager.isUserConnected(participantId)) {
          await firebaseService.sendVideoCallNotification(
            participantId,
            'Video consultation started',
            roomId,
            videoRoom.appointmentId || undefined
          );
        }
      }

      loggingService.log(LogLevel.INFO, LogCategory.EXTERNAL_SERVICE, 'Video room session started', {
        roomId,
        conversationId: videoRoom.conversationId,
        startedBy: userId
      });
      return true;

    } catch (error) {
      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Failed to start video room', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
        userId
      });
      return false;
    }
  }

  /**
   * End a video room session
   */
  async endVideoRoom(roomId: string, userId: string): Promise<boolean> {
    try {
      const videoRoom = await prisma.videoRoom.findUnique({
        where: { roomId },
        include: {
          conversation: {
            select: {
              clientId: true,
              lawyerId: true
            }
          }
        }
      });

      if (!videoRoom) {
        return false;
      }

      // Calculate duration
      let actualDuration = 0;
      if (videoRoom.startedAt) {
        actualDuration = Math.floor((new Date().getTime() - videoRoom.startedAt.getTime()) / (1000 * 60));
      }

      // Update room status
      await prisma.videoRoom.update({
        where: { roomId },
        data: {
          status: 'ended',
          endedAt: new Date(),
          actualDuration
        }
      });

      await this.trackParticipantLeave(videoRoom.id, userId);
      await prisma.videoSessionMetric.updateMany({
        where: {
          roomId: videoRoom.id,
          leftAt: null
        },
        data: {
          leftAt: new Date()
        }
      });

      // Stop any active recordings
      const activeRecordings = await prisma.videoRecording.findMany({
        where: {
          roomId: videoRoom.id ?? undefined,
          status: 'recording'
        }
      });

      for (const recording of activeRecordings) {
        await this.stopRecording(recording.id, userId);
      }

      // Notify participants
      await webSocketManager.broadcastToRoom(
        videoRoom.conversationId,
        'video_room_ended',
        {
          roomId,
          endedBy: userId,
          duration: actualDuration,
          timestamp: new Date()
        }
      );

      // Log room end
      await prisma.communicationAuditLog.create({
        data: {
          eventType: 'video_room_ended',
          eventData: {
            roomId: videoRoom.id ?? undefined,
            duration: actualDuration,
            endedBy: userId
          },
          initiatedBy: userId,
          conversationId: videoRoom.conversationId ?? undefined,
          isPrivileged: true
        }
      });

      const kpi = await this.computeAndStoreKpis(videoRoom.id);

      loggingService.log(LogLevel.INFO, LogCategory.EXTERNAL_SERVICE, 'Video room session ended', {
        roomId,
        conversationId: videoRoom.conversationId,
        endedBy: userId,
        durationMinutes: actualDuration,
        kpi
      });
      return true;

    } catch (error) {
      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Failed to end video room', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
        userId
      });
      return false;
    }
  }

  /**
   * Start recording a video room session
   */
  async startRecording(roomId: string, userId: string, consentData: RecordingConsentInput): Promise<string | null> {
    try {
      if (!twilioConfig.isConfigured) {
        throw new Error('Twilio video provider is not configured');
      }

      const videoRoom = await prisma.videoRoom.findUnique({
        where: { roomId },
        include: {
          conversation: {
            select: {
              clientId: true,
              lawyerId: true
            }
          }
        }
      });

      if (!videoRoom) {
        throw new Error('Video room not found');
      }

      // Check if recording is enabled
      if (!videoRoom.recordingEnabled) {
        throw new Error('Recording is not enabled for this room');
      }

      const twilioRoomSid = (videoRoom as any).twilioRoomSid as string | undefined;
      if (!twilioRoomSid) {
        throw new Error('Twilio room is not initialized for recording');
      }

  const consentMap = this.normalizeConsentInput(consentData);
  const consentJson = consentMap as unknown as Prisma.InputJsonValue;
      // Verify all participants have consented
      const participants = [videoRoom.conversation.clientId, videoRoom.conversation.lawyerId];
      const missingConsent = participants.filter(participantId => !consentMap[participantId]?.consented);
      if (missingConsent.length > 0) {
        throw new Error('All participants must consent to recording');
      }

      const twilioClient = getTwilioClient();
      await twilioClient.video.v1.rooms(twilioRoomSid).recordingRules.update({
        rules: [
          {
            type: 'include',
            all: true
          }
        ]
      });

      // Create recording record
      const recording = await prisma.videoRecording.create({
        data: {
          roomId: videoRoom.id ?? undefined,
          appointmentId: videoRoom.appointmentId ?? undefined,
          recordingName: `Consultation Recording - ${new Date().toISOString()}`,
          status: 'recording',
          consentRecorded: true,
          consentTimestamp: new Date(),
          processingStartedAt: new Date()
        }
      });

      // Update room with recording consent
      await prisma.videoRoom.update({
        where: { roomId },
        data: {
          recordingConsent: consentJson
        }
      });

      // Notify participants
      await webSocketManager.broadcastToRoom(
        videoRoom.conversationId,
        'recording_started',
        {
          recordingId: recording.id,
          roomId,
          startedBy: userId,
          timestamp: new Date()
        }
      );

      // Log recording start
      await prisma.communicationAuditLog.create({
        data: {
          eventType: 'recording_started',
          eventData: {
            recordingId: recording.id,
            roomId: videoRoom.id ?? undefined,
            consent: consentMap
          } as unknown as Prisma.InputJsonValue,
          initiatedBy: userId,
          conversationId: videoRoom.conversationId ?? undefined,
          isPrivileged: true
        }
      });

      loggingService.log(LogLevel.INFO, LogCategory.EXTERNAL_SERVICE, 'Recording started', {
        roomId,
        recordingId: recording.id,
        startedBy: userId
      });
      return recording.id;

    } catch (error) {
      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Failed to start recording', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
        userId
      });
      return null;
    }
  }

  /**
   * Stop recording a video room session
   */
  async stopRecording(recordingId: string, userId: string): Promise<boolean> {
    try {
      const recording = await prisma.videoRecording.findUnique({
        where: { id: recordingId },
        include: {
          videoRoom: {
            include: {
              conversation: {
                select: {
                  clientId: true,
                  lawyerId: true
                }
              }
            }
          }
        }
      });

      if (!recording) {
        return false;
      }

      const twilioRoomSid = (recording.videoRoom as any).twilioRoomSid as string | undefined;

      // Calculate recording duration
      let duration = 0;
      if (recording.processingStartedAt) {
        duration = Math.floor((new Date().getTime() - recording.processingStartedAt.getTime()) / 1000);
      }

      if (twilioConfig.isConfigured && twilioRoomSid) {
        const twilioClient = getTwilioClient();
        await twilioClient.video.v1.rooms(twilioRoomSid).recordingRules.update({
          rules: [
            {
              type: 'exclude',
              all: true
            }
          ]
        });
      }

      let recordingUrl: string | undefined;
      let providerRecordingSid: string | undefined;

      if (twilioConfig.isConfigured && twilioRoomSid) {
        try {
          const recordingList = await getTwilioClient().video.v1.rooms(twilioRoomSid).recordings.list({ limit: 1 });
          const providerRecording = recordingList[0];
          if (providerRecording) {
            providerRecordingSid = providerRecording.sid;
            recordingUrl = `https://video.twilio.com/v1/Rooms/${twilioRoomSid}/Recordings/${providerRecording.sid}`;
          }
        } catch (twilioError) {
          loggingService.log(LogLevel.WARN, LogCategory.EXTERNAL_SERVICE, 'Failed to fetch Twilio recording metadata', {
            error: twilioError instanceof Error ? twilioError.message : String(twilioError),
            recordingId,
            twilioRoomSid
          });
        }
      }

      // Update recording status
      await prisma.videoRecording.update({
        where: { id: recordingId },
        data: {
          status: 'processing',
          duration,
          processingCompletedAt: new Date(),
          recordingUrl,
          providerRecordingSid
        } as Prisma.VideoRecordingUncheckedUpdateInput
      });

      // Notify participants
      await webSocketManager.broadcastToRoom(
        recording.videoRoom.conversationId,
        'recording_stopped',
        {
          recordingId,
          duration,
          stoppedBy: userId,
          timestamp: new Date()
        }
      );

      loggingService.log(LogLevel.INFO, LogCategory.EXTERNAL_SERVICE, 'Recording stopped', {
        recordingId,
        roomId: recording.videoRoom.roomId,
        durationSeconds: duration
      });
      return true;

    } catch (error) {
      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Failed to stop recording', {
        error: error instanceof Error ? error.message : String(error),
        recordingId,
        userId
      });
      return false;
    }
  }

  async markParticipantLeft(
    roomId: string,
    userId: string,
    options: { reason?: string; audioFallbackUsed?: boolean } = {}
  ): Promise<boolean> {
    try {
      const videoRoom = await prisma.videoRoom.findUnique({
        where: { roomId },
        include: {
          conversation: {
            select: {
              clientId: true,
              lawyerId: true
            }
          }
        }
      });

      if (!videoRoom) {
        return false;
      }

      const conversation = videoRoom.conversation;
      if (userId !== conversation.clientId && userId !== conversation.lawyerId) {
        throw new Error('Access denied to video room');
      }

      await this.trackParticipantLeave(videoRoom.id, userId, options.audioFallbackUsed, options.reason);

      await prisma.communicationAuditLog.create({
        data: {
          eventType: 'video_participant_left',
          eventData: {
            roomId: videoRoom.id,
            participantId: userId,
            reason: options.reason,
            audioFallbackUsed: options.audioFallbackUsed ?? false
          } as unknown as Prisma.InputJsonValue,
          initiatedBy: userId,
          conversationId: videoRoom.conversationId,
          isPrivileged: false
        }
      });

      return true;
    } catch (error) {
      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Failed to mark participant left', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
        userId
      });
      return false;
    }
  }

  async requestAudioFallback(roomId: string, userId: string): Promise<AudioFallbackDetails | null> {
    try {
      const videoRoom = await prisma.videoRoom.findUnique({
        where: { roomId },
        include: {
          conversation: {
            select: {
              clientId: true,
              lawyerId: true
            }
          }
        }
      });

      if (!videoRoom) {
        return null;
      }

      const conversation = videoRoom.conversation;
      if (userId !== conversation.clientId && userId !== conversation.lawyerId) {
        throw new Error('Access denied to video room');
      }

      const audioFallback = getAudioFallbackDetails(userId);
      if (!audioFallback.enabled) {
        return audioFallback;
      }

      await this.markAudioFallbackUsage(videoRoom.id, userId);

      await prisma.communicationAuditLog.create({
        data: {
          eventType: 'audio_fallback_requested',
          eventData: {
            roomId: videoRoom.id,
            participantId: userId
          } as unknown as Prisma.InputJsonValue,
          initiatedBy: userId,
          conversationId: videoRoom.conversationId,
          isPrivileged: false
        }
      });

      return audioFallback;
    } catch (error) {
      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Failed to provide audio fallback', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
        userId
      });
      return null;
    }
  }

  /**
   * Get recordings for a conversation
   */
  async getConversationRecordings(conversationId: string, userId: string): Promise<RecordingInfo[]> {
    try {
      // Validate access
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { clientId: true, lawyerId: true }
      });

      if (!conversation) {
        return [];
      }

      if (userId !== conversation.clientId && userId !== conversation.lawyerId) {
        return [];
      }

      const recordings = await prisma.videoRecording.findMany({
        where: {
          videoRoom: {
            conversationId
          },
          status: { in: ['completed', 'processing'] }
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          recordingName: true,
          duration: true,
          fileSize: true,
          status: true,
          recordingUrl: true,
          thumbnailUrl: true,
          transcriptUrl: true,
          consentRecorded: true,
          accessLevel: true,
          createdAt: true,
          providerRecordingSid: true
        }
      });

      return recordings.map(recording => {
        const providerRecordingSid = (recording as any).providerRecordingSid as string | undefined;

        return {
        id: recording.id,
        recordingName: recording.recordingName || undefined,
        duration: recording.duration || undefined,
        fileSize: recording.fileSize ? Number(recording.fileSize) : undefined,
        status: recording.status,
        recordingUrl: recording.recordingUrl || undefined,
        thumbnailUrl: recording.thumbnailUrl || undefined,
        transcriptUrl: recording.transcriptUrl || undefined,
        consentRecorded: recording.consentRecorded,
        accessLevel: recording.accessLevel,
        createdAt: recording.createdAt,
        providerRecordingSid
      };
      });

    } catch (error) {
      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Failed to get conversation recordings', {
        error: error instanceof Error ? error.message : String(error),
        conversationId
      });
      return [];
    }
  }

  /**
   * Get video room information
   */
  async getVideoRoomInfo(roomId: string, userId: string): Promise<VideoRoomInfo | null> {
    try {
      const videoRoom = await prisma.videoRoom.findUnique({
        where: { roomId },
        include: {
          conversation: {
            select: {
              clientId: true,
              lawyerId: true
            }
          }
        }
      });

      if (!videoRoom) {
        return null;
      }

      // Validate access
      const conversation = videoRoom.conversation;
      if (userId !== conversation.clientId && userId !== conversation.lawyerId) {
        return null;
      }

      const baseUrl = process.env.FRONTEND_URL || 'https://app.lawyerconsult.com';
      const joinUrl = `${baseUrl}/video/join/${roomId}`;
      const hostJoinUrl = `${baseUrl}/video/host/${roomId}`;

      const recordingConsent = this.deserializeConsent((videoRoom as any).recordingConsent);
      const twilioRoomSid = (videoRoom as any).twilioRoomSid as string | undefined;
      const kpiRecord = await prisma.videoSessionKpi.findUnique({
        where: { roomId: videoRoom.id }
      });

      return {
        id: videoRoom.id ?? undefined,
        roomId: videoRoom.roomId ?? undefined,
        roomPassword: this.decryptPassword(videoRoom.roomPassword),
        roomName: videoRoom.roomName ?? undefined,
        status: videoRoom.status ?? undefined,
        appointmentId: videoRoom.appointmentId ?? undefined,
        conversationId: videoRoom.conversationId ?? undefined,
        hostId: videoRoom.hostId ?? undefined,
        participantIds: this.parseParticipantIds(videoRoom.participantIds as Prisma.JsonValue),
        maxParticipants: videoRoom.maxParticipants ?? undefined,
        recordingEnabled: videoRoom.recordingEnabled ?? undefined,
        recordingConsent,
        waitingRoomEnabled: videoRoom.waitingRoomEnabled ?? undefined,
        screenSharingEnabled: videoRoom.screenSharingEnabled ?? undefined,
        chatEnabled: videoRoom.chatEnabled ?? undefined,
        startedAt: videoRoom.startedAt ?? undefined,
        endedAt: videoRoom.endedAt ?? undefined,
        actualDuration: videoRoom.actualDuration ?? undefined,
        joinUrl,
        hostJoinUrl,
        provider: 'twilio',
        twilioRoomSid,
        kpi: kpiRecord
          ? {
              averageJoinTimeMs: kpiRecord.averageJoinTimeMs ?? undefined,
              dropRate: kpiRecord.dropRate ?? undefined,
              audioFallbackCount: kpiRecord.audioFallbackCount,
              participantCount: kpiRecord.participantCount ?? undefined
            }
          : undefined
      };

    } catch (error) {
      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Failed to get video room info', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
        userId
      });
      return null;
    }
  }

  // Private helper methods

  private generateRoomId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private generateRoomPassword(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  private getTwilioRoomName(roomId: string, conversationId: string): string {
    const prefix = twilioConfig.defaultRoomPrefix || 'lc-consult';
    const sanitizedConversationId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '');
    return `${prefix}-${sanitizedConversationId}-${roomId}`.slice(0, 100);
  }

  private normalizeConsentInput(consentInput: RecordingConsentInput): RecordingConsentMap {
    const normalized: RecordingConsentMap = {};
    const nowIso = new Date().toISOString();

    for (const [participantId, value] of Object.entries(consentInput)) {
      if (typeof value === 'boolean') {
        normalized[participantId] = {
          consented: value,
          consentedAt: nowIso
        };
      } else if (value && typeof value === 'object' && 'consented' in value) {
        normalized[participantId] = {
          consented: Boolean(value.consented),
          consentedAt: value.consentedAt ?? nowIso
        };
      }
    }

    return normalized;
  }

  private deserializeConsent(consentJson: unknown): RecordingConsentMap {
    if (!consentJson || typeof consentJson !== 'object') {
      return {};
    }

    const normalized: RecordingConsentMap = {};
    const entries = Object.entries(consentJson as Record<string, unknown>);

    for (const [participantId, value] of entries) {
      if (typeof value === 'boolean') {
        normalized[participantId] = {
          consented: value,
          consentedAt: new Date().toISOString()
        };
      } else if (value && typeof value === 'object' && 'consented' in (value as Record<string, unknown>)) {
        const consentObject = value as { consented?: unknown; consentedAt?: unknown };
        normalized[participantId] = {
          consented: Boolean(consentObject.consented),
          consentedAt: typeof consentObject.consentedAt === 'string' ? consentObject.consentedAt : new Date().toISOString()
        };
      }
    }

    return normalized;
  }

  private parseParticipantIds(value: Prisma.JsonValue | null | undefined): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }
    return [];
  }

  private async trackParticipantJoin(
    videoRoomId: string,
    participantId: string,
    joinLatencyMs: number,
    audioFallbackUsed: boolean
  ): Promise<void> {
    const updateData: Prisma.VideoSessionMetricUpdateInput = {
      joinedAt: new Date(),
      joinLatencyMs,
      reconnectionCount: { increment: 1 }
    };

    if (audioFallbackUsed) {
      updateData.audioFallbackUsed = true;
    }

    await prisma.videoSessionMetric.upsert({
      where: {
        roomId_participantId: {
          roomId: videoRoomId,
          participantId
        }
      },
      create: {
        roomId: videoRoomId,
        participantId,
        joinLatencyMs,
        audioFallbackUsed
      },
      update: updateData
    });
  }

  private async trackParticipantLeave(
    videoRoomId: string,
    participantId: string,
    audioFallbackUsed?: boolean,
    disconnectReason?: string
  ): Promise<void> {
    const updateData: Prisma.VideoSessionMetricUpdateInput = {
      leftAt: new Date()
    };

    if (audioFallbackUsed) {
      updateData.audioFallbackUsed = true;
    }

    if (disconnectReason) {
      updateData.disconnectReason = disconnectReason;
    }

    await prisma.videoSessionMetric.upsert({
      where: {
        roomId_participantId: {
          roomId: videoRoomId,
          participantId
        }
      },
      create: {
        roomId: videoRoomId,
        participantId,
        joinedAt: new Date(),
        leftAt: new Date(),
        audioFallbackUsed: Boolean(audioFallbackUsed),
        disconnectReason: disconnectReason ?? undefined
      },
      update: updateData
    });
  }

  private async markAudioFallbackUsage(videoRoomId: string, participantId: string): Promise<void> {
    await prisma.videoSessionMetric.upsert({
      where: {
        roomId_participantId: {
          roomId: videoRoomId,
          participantId
        }
      },
      create: {
        roomId: videoRoomId,
        participantId,
        joinedAt: new Date(),
        audioFallbackUsed: true
      },
      update: {
        audioFallbackUsed: true
      }
    });
  }

  private async computeAndStoreKpis(videoRoomId: string): Promise<VideoRoomKpi | null> {
    const [metrics, videoRoom] = await Promise.all([
      prisma.videoSessionMetric.findMany({
        where: { roomId: videoRoomId }
      }),
      prisma.videoRoom.findUnique({
        where: { id: videoRoomId },
        select: { startedAt: true, endedAt: true }
      })
    ]);

    if (!metrics.length) {
      return null;
    }

    const joinTimes = metrics
      .map(metric => metric.joinLatencyMs)
      .filter((value): value is number => typeof value === 'number');

    const averageJoinTimeMs = joinTimes.length
      ? Math.round(joinTimes.reduce((acc, value) => acc + value, 0) / joinTimes.length)
      : undefined;

    let dropRate: number | undefined;

    if (videoRoom?.endedAt) {
      const dropCount = metrics.filter(metric => {
        if (!metric.leftAt) {
          return false;
        }
        return metric.leftAt.getTime() + VIDEO_DROP_THRESHOLD_MS < videoRoom.endedAt!.getTime();
      }).length;

      dropRate = metrics.length ? Number((dropCount / metrics.length).toFixed(4)) : undefined;
    }

    const audioFallbackCount = metrics.filter(metric => metric.audioFallbackUsed).length;

    await prisma.videoSessionKpi.upsert({
      where: { roomId: videoRoomId },
      create: {
        roomId: videoRoomId,
        averageJoinTimeMs: averageJoinTimeMs ?? null,
        dropRate: dropRate ?? null,
        audioFallbackCount,
        participantCount: metrics.length
      },
      update: {
        averageJoinTimeMs: averageJoinTimeMs ?? null,
        dropRate: dropRate ?? null,
        audioFallbackCount,
        participantCount: metrics.length,
        computedAt: new Date()
      }
    });

    return {
      averageJoinTimeMs,
      dropRate,
      audioFallbackCount,
      participantCount: metrics.length
    };
  }

  private encryptPassword(password: string): string {
    return Buffer.from(password).toString('base64');
  }

  private decryptPassword(encryptedPassword: string | null): string | undefined {
    if (!encryptedPassword) return undefined;
    try {
      return Buffer.from(encryptedPassword, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * Clean up expired rooms
   */
  async cleanupExpiredRooms(): Promise<void> {
    try {
      const expiredTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

      await prisma.videoRoom.updateMany({
        where: {
          status: 'created',
          createdAt: { lt: expiredTime }
        },
        data: {
          status: 'expired'
        }
      });

      loggingService.log(LogLevel.INFO, LogCategory.EXTERNAL_SERVICE, 'Expired video rooms cleaned up', {
        cutoff: expiredTime.toISOString()
      });

    } catch (error) {
      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Failed to cleanup expired rooms', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

// Create singleton instance
const videoConsultationService = new VideoConsultationService();

export default videoConsultationService;
export { VideoRoomConfig, VideoRoomInfo, JoinCredentials, RecordingInfo };