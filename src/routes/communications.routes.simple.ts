import express, { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import videoConsultationService from '../services/videoConsultation.service';

const router = express.Router();

// Basic health check endpoint for testing
router.get('/health', async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: {
        webSocket: {
          activeConnections: 0,
          activeConversations: 0
        },
        database: {
          totalActiveConversations: 0,
          messagesLast24h: 0
        },
        services: {
          messaging: 'healthy',
          encryption: 'healthy',
          firebase: 'healthy'
        },
        timestamp: new Date()
      }
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({
      success: false,
      error: 'Health check failed'
    });
  }
});

// Basic conversations endpoint
router.get('/conversations', requireAuth, async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: [],
      message: 'Communication system is ready - database migration needed'
    });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get conversations'
    });
  }
});

// Start a new conversation
router.post('/start-conversation', requireAuth, async (req: Request, res: Response) => {
  try {
    const { participantIds, type = 'private', title } = req.body;
    
    if (!participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'participantIds array is required and must not be empty'
      });
    }

    // Validate that current user is included in participants
    const currentUserId = req.user?.id;
    if (!participantIds.includes(currentUserId)) {
      participantIds.push(currentUserId);
    }

    // For now, return a mock conversation until database schema is ready
    const mockConversation = {
      id: `conv_${Date.now()}`,
      participantIds,
      type,
      title: title || `Conversation with ${participantIds.length} participants`,
      createdAt: new Date(),
      lastMessageAt: new Date(),
      isActive: true
    };

    res.status(201).json({
      success: true,
      data: mockConversation,
      message: 'Conversation endpoint ready - real conversations require database schema'
    });
  } catch (error) {
    console.error('Start conversation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start conversation'
    });
  }
});

// Basic presence endpoint
router.get('/presence', requireAuth, async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: [],
      message: 'Presence service is ready - database migration needed'
    });
  } catch (error) {
    console.error('Get presence error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get presence information'
    });
  }
});

// --- Video consultation endpoints ---

router.post('/video/rooms', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const {
      conversationId,
      appointmentId,
      roomName,
      recordingEnabled = true,
      waitingRoomEnabled = true,
      screenSharingEnabled = true,
      chatEnabled = true,
      maxParticipants = 2
    } = req.body || {};

    if (!conversationId || typeof conversationId !== 'string') {
      return res.status(400).json({ success: false, error: 'conversationId is required' });
    }

    const videoRoom = await videoConsultationService.createVideoRoom({
      conversationId,
      appointmentId,
      hostId: userId,
      roomName,
      recordingEnabled,
      waitingRoomEnabled,
      screenSharingEnabled,
      chatEnabled,
      maxParticipants
    });

    if (!videoRoom) {
      return res.status(500).json({ success: false, error: 'Failed to create video room' });
    }

    res.status(201).json({
      success: true,
      data: videoRoom
    });
  } catch (error) {
    console.error('Create video room error:', error);
    res.status(500).json({ success: false, error: 'Failed to create video room' });
  }
});

router.get('/video/rooms/:roomId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { roomId } = req.params;
    const info = await videoConsultationService.getVideoRoomInfo(roomId, userId);

    if (!info) {
      return res.status(404).json({ success: false, error: 'Video room not found' });
    }

    res.json({ success: true, data: info });
  } catch (error) {
    console.error('Get video room info error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch video room info' });
  }
});

router.post('/video/rooms/:roomId/join', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { roomId } = req.params;
    const credentials = await videoConsultationService.getJoinCredentials(roomId, userId);

    if (!credentials) {
      return res.status(404).json({ success: false, error: 'Unable to generate join credentials' });
    }

    res.json({ success: true, data: credentials });
  } catch (error) {
    console.error('Get join credentials error:', error);
    res.status(500).json({ success: false, error: 'Failed to get join credentials' });
  }
});

router.post('/video/rooms/:roomId/start', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { roomId } = req.params;
    const success = await videoConsultationService.startVideoRoom(roomId, userId);

    if (!success) {
      return res.status(400).json({ success: false, error: 'Failed to start video room' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Start video room error:', error);
    res.status(500).json({ success: false, error: 'Failed to start video room' });
  }
});

router.post('/video/rooms/:roomId/end', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { roomId } = req.params;
    const success = await videoConsultationService.endVideoRoom(roomId, userId);

    if (!success) {
      return res.status(400).json({ success: false, error: 'Failed to end video room' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('End video room error:', error);
    res.status(500).json({ success: false, error: 'Failed to end video room' });
  }
});

router.post('/video/rooms/:roomId/recordings/start', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { roomId } = req.params;
    const consent = req.body?.consent;

    if (!consent || typeof consent !== 'object') {
      return res.status(400).json({ success: false, error: 'Consent map is required' });
    }

    const recordingId = await videoConsultationService.startRecording(roomId, userId, consent);

    if (!recordingId) {
      return res.status(400).json({ success: false, error: 'Unable to start recording' });
    }

    res.status(201).json({ success: true, data: { recordingId } });
  } catch (error) {
    console.error('Start recording error:', error);
    res.status(500).json({ success: false, error: 'Failed to start recording' });
  }
});

router.post('/video/rooms/:roomId/recordings/:recordingId/stop', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { recordingId } = req.params;
    const success = await videoConsultationService.stopRecording(recordingId, userId);

    if (!success) {
      return res.status(400).json({ success: false, error: 'Failed to stop recording' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Stop recording error:', error);
    res.status(500).json({ success: false, error: 'Failed to stop recording' });
  }
});

router.get('/video/rooms/:roomId/recordings', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { roomId } = req.params;
    const roomInfo = await videoConsultationService.getVideoRoomInfo(roomId, userId);

    if (!roomInfo) {
      return res.status(404).json({ success: false, error: 'Video room not found' });
    }

    const recordings = await videoConsultationService.getConversationRecordings(roomInfo.conversationId, userId);
    res.json({ success: true, data: recordings });
  } catch (error) {
    console.error('Get recordings error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch recordings' });
  }
});

router.post('/video/rooms/:roomId/fallback/audio', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { roomId } = req.params;
    const details = await videoConsultationService.requestAudioFallback(roomId, userId);

    if (!details) {
      return res.status(404).json({ success: false, error: 'Video room not found' });
    }

    res.json({ success: true, data: details });
  } catch (error) {
    console.error('Audio fallback error:', error);
    res.status(500).json({ success: false, error: 'Failed to provide audio fallback' });
  }
});

router.post('/video/rooms/:roomId/participants/leave', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { roomId } = req.params;
    const { reason, audioFallbackUsed } = req.body || {};
    const success = await videoConsultationService.markParticipantLeft(roomId, userId, {
      reason,
      audioFallbackUsed
    });

    if (!success) {
      return res.status(400).json({ success: false, error: 'Failed to update participant session' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Leave video room error:', error);
    res.status(500).json({ success: false, error: 'Failed to update participant session' });
  }
});

export default router;