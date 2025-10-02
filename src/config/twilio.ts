import Twilio, { Twilio as TwilioClient, jwt } from 'twilio';

const {
  AccessToken
} = jwt;

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const apiKeySid = process.env.TWILIO_API_KEY;
const apiKeySecret = process.env.TWILIO_API_SECRET;
const voiceApplicationSid = process.env.TWILIO_VOICE_APPLICATION_SID;
const fallbackDialInNumber = process.env.TWILIO_FALLBACK_DIAL_IN_NUMBER;

let twilioClient: TwilioClient | null = null;

const isConfigured = Boolean(accountSid && authToken && apiKeySid && apiKeySecret);

if (isConfigured) {
  twilioClient = Twilio(accountSid!, authToken!);
}

export interface VideoTokenOptions {
  ttlSeconds?: number;
  includeVoiceGrant?: boolean;
}

export interface AudioFallbackDetails {
  enabled: boolean;
  dialInNumber?: string;
  token?: string;
  expiresAt?: Date;
}

export const twilioConfig = {
  isConfigured,
  accountSid,
  voiceApplicationSid,
  fallbackDialInNumber,
  defaultRoomPrefix: process.env.TWILIO_VIDEO_ROOM_PREFIX || 'lc-consult'
};

export function getTwilioClient(): TwilioClient {
  if (!twilioClient) {
    throw new Error('Twilio is not configured. Ensure account SID, auth token, API key, and secret are set.');
  }
  return twilioClient;
}

export function buildVideoAccessToken(
  identity: string,
  roomName: string,
  options: VideoTokenOptions = {}
): { token: string; expiresAt: Date } {
  if (!isConfigured) {
    throw new Error('Twilio video access token requested but Twilio is not configured.');
  }

  const ttlSeconds = options.ttlSeconds ?? 3600;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const token = new AccessToken(accountSid!, apiKeySid!, apiKeySecret!, {
    identity,
    ttl: ttlSeconds
  });

  const videoGrant = new AccessToken.VideoGrant({ room: roomName });
  token.addGrant(videoGrant);

  if (options.includeVoiceGrant && voiceApplicationSid) {
    const voiceGrant = new AccessToken.VoiceGrant({
      outgoingApplicationSid: voiceApplicationSid,
      incomingAllow: true
    });
    token.addGrant(voiceGrant);
  }

  return {
    token: token.toJwt(),
    expiresAt
  };
}

export function buildAudioFallbackToken(identity: string, options: { ttlSeconds?: number } = {}): { token: string; expiresAt: Date } | null {
  if (!isConfigured || !voiceApplicationSid) {
    return null;
  }

  const ttlSeconds = options.ttlSeconds ?? 3600;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const token = new AccessToken(accountSid!, apiKeySid!, apiKeySecret!, {
    identity,
    ttl: ttlSeconds
  });

  const voiceGrant = new AccessToken.VoiceGrant({
    outgoingApplicationSid: voiceApplicationSid,
    incomingAllow: true
  });
  token.addGrant(voiceGrant);

  return {
    token: token.toJwt(),
    expiresAt
  };
}

export function getAudioFallbackDetails(identity: string): AudioFallbackDetails {
  const audioToken = buildAudioFallbackToken(identity);

  return {
    enabled: Boolean(audioToken),
    dialInNumber: fallbackDialInNumber || undefined,
    token: audioToken?.token,
    expiresAt: audioToken?.expiresAt
  };
}
