import { Platform } from 'react-native';
import * as Speech from 'expo-speech';

const CARTESIA_API_KEY = (process.env.EXPO_PUBLIC_CARTESIA_API_KEY || '').trim();
const BACKEND_API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://sensoo-app-final-2.onrender.com/api/v1';

export const CARTESIA_VOICES = {
  JACQUELINE_REASSURING: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc', // Calm, reassuring medical/safety female voice
  YASMIN_DIALOGUE: '9zDWKPmuRaJcTg4z4YRNEM',
  RAY_CONVERSATIONAL: '565510e8-6b45-45de-8758-13588fbaec73', // Natural human male voice
};

// Default to the natural male conversational voice
export const DEFAULT_CARTESIA_VOICE = CARTESIA_VOICES.RAY_CONVERSATIONAL;
export const CARTESIA_MODEL = 'sonic-2';

// In-memory player references
let activeWebAudio: HTMLAudioElement | null = null;
let activeNativePlayer: any = null;
let activeSpeechPromiseResolver: (() => void) | null = null;

/**
 * Returns true if the Cartesia API key is present in environment variables.
 */
export function isCartesiaConfigured(): boolean {
  return Boolean(CARTESIA_API_KEY && CARTESIA_API_KEY.trim().length > 0);
}

/**
 * Convert binary ArrayBuffer to Base64 string for file writing / data URIs.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let base64 = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    base64 += chars[b0 >> 2];
    base64 += chars[((b0 & 3) << 4) | (b1 >> 4)];
    base64 += i + 1 < len ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    base64 += i + 2 < len ? chars[b2 & 63] : '=';
  }
  return base64;
}

/**
 * Clean transcript text of Markdown asterisks, URLs, and code blocks before speech synthesis.
 */
export function cleanTextForSpeech(rawText: string): string {
  if (!rawText) return '';
  return rawText
    .replace(/[*_#`~>]/g, '') // remove markdown symbols
    .replace(/https?:\/\/\S+/g, '') // remove urls
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // link labels only
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stop any ongoing audio playback across Cartesia (Web & Native) and Expo Speech.
 */
export function stopCartesiaSpeech(): void {
  try {
    if (activeWebAudio) {
      activeWebAudio.pause();
      activeWebAudio.currentTime = 0;
      activeWebAudio = null;
    }
  } catch (e) {
    console.warn('[Cartesia] Error stopping web audio:', e);
  }

  try {
    if (activeNativePlayer) {
      if (typeof activeNativePlayer.pause === 'function') {
        activeNativePlayer.pause();
      }
      if (typeof activeNativePlayer.remove === 'function') {
        activeNativePlayer.remove();
      }
      activeNativePlayer = null;
    }
  } catch (e) {
    console.warn('[Cartesia] Error stopping native audio:', e);
  }

  try {
    Speech.stop();
  } catch {
    // ignore
  }

  if (activeSpeechPromiseResolver) {
    activeSpeechPromiseResolver();
    activeSpeechPromiseResolver = null;
  }
}

/**
 * Synthesizes speech using Cartesia Sonic API (or Backend proxy if direct is unavailable)
 * and plays it aloud on the current platform.
 */
export async function speakWithCartesia(
  text: string,
  options?: {
    voiceId?: string;
    modelId?: string;
    onStart?: () => void;
    onDone?: () => void;
    onError?: (err: any) => void;
  }
): Promise<boolean> {
  const clean = cleanTextForSpeech(text);
  if (!clean) return false;

  // Interrupt prior speech first
  stopCartesiaSpeech();

  const voiceId = options?.voiceId || DEFAULT_CARTESIA_VOICE;
  const modelId = options?.modelId || CARTESIA_MODEL;

  try {
    let audioBytes: ArrayBuffer | null = null;

    // 1. Direct Cartesia Sonic REST API (fastest & most reliable on device)
    if (isCartesiaConfigured()) {
      try {
        const resp = await fetch('https://api.cartesia.ai/tts/bytes', {
          method: 'POST',
          headers: {
            'X-API-Key': CARTESIA_API_KEY,
            'Cartesia-Version': '2024-06-10',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            transcript: clean,
            model_id: modelId,
            voice: {
              mode: 'id',
              id: voiceId,
            },
            output_format: {
              container: 'mp3',
              bit_rate: 128000,
              sample_rate: 44100,
            },
          }),
        });

        if (resp.ok) {
          audioBytes = await resp.arrayBuffer();
        } else {
          const errText = await resp.text();
          console.warn('[Cartesia] Direct API error:', resp.status, errText);
        }
      } catch (directErr) {
        console.warn('[Cartesia] Direct fetch failed, attempting backend proxy:', directErr);
      }
    }

    // 2. Secondary: Sensoo Backend (/api/v1/ai/tts) if available
    if (!audioBytes) {
      try {
        const backendResp = await fetch(`${BACKEND_API_URL}/ai/tts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: clean,
            voice_id: voiceId,
            model_id: modelId,
          }),
        });

        if (backendResp.ok) {
          audioBytes = await backendResp.arrayBuffer();
        }
      } catch (backendErr) {
        console.warn('[Cartesia] Backend proxy route failed:', backendErr);
      }
    }

    // 3. Play audio if synthesized
    if (audioBytes && audioBytes.byteLength > 0) {
      options?.onStart?.();

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        return playWebAudio(audioBytes, options?.onDone, options?.onError);
      } else {
        return playNativeAudio(audioBytes, options?.onDone, options?.onError);
      }
    }

    // Never fall back to robotic device Speech.speak
    console.warn('[Cartesia] Audio synthesis returned no bytes; remaining silent.');
    options?.onError?.(new Error('Cartesia audio synthesis unavailable'));
    return false;
  } catch (error) {
    console.error('[Cartesia] Synthesis failed:', error);
    options?.onError?.(error);
    return false;
  }
}

/**
 * Play audio in Web environment via HTML5 Audio element.
 */
function playWebAudio(
  buffer: ArrayBuffer,
  onDone?: () => void,
  onError?: (err: any) => void
): boolean {
  try {
    const blob = new Blob([buffer], { type: 'audio/mpeg' });
    const blobUrl = URL.createObjectURL(blob);
    const audio = new Audio(blobUrl);
    activeWebAudio = audio;

    audio.onended = () => {
      URL.revokeObjectURL(blobUrl);
      activeWebAudio = null;
      onDone?.();
    };

    audio.onerror = (e) => {
      URL.revokeObjectURL(blobUrl);
      activeWebAudio = null;
      onError?.(e);
    };

    audio.play().catch((playErr) => {
      console.warn('[Cartesia] Web audio.play() blocked or failed:', playErr);
      onDone?.();
    });

    return true;
  } catch (e) {
    console.warn('[Cartesia] Web playback error:', e);
    onError?.(e);
    return false;
  }
}

/**
 * Play audio in Native Android / iOS environment via expo-audio and cache file.
 */
async function playNativeAudio(
  buffer: ArrayBuffer,
  onDone?: () => void,
  onError?: (err: any) => void
): Promise<boolean> {
  try {
    const base64Audio = arrayBufferToBase64(buffer);

    // Dynamically load expo-file-system and expo-audio to prevent web bundle errors
    const FileSystem = await import('expo-file-system/legacy');
    const { createAudioPlayer } = await import('expo-audio');

    const cacheFileUri = `${FileSystem.cacheDirectory || ''}cartesia_voice_${Date.now()}.mp3`;

    await FileSystem.writeAsStringAsync(cacheFileUri, base64Audio, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const player = createAudioPlayer(cacheFileUri);
    activeNativePlayer = player;

    if (typeof player.play === 'function') {
      player.play();
    }

    // Listen for completion if supported or calculate timeout from byte size
    const estimatedDurationMs = Math.max(1200, (buffer.byteLength / 16000) * 1000);
    setTimeout(() => {
      if (activeNativePlayer === player) {
        activeNativePlayer = null;
        onDone?.();
        // Clean up temp file
        FileSystem.deleteAsync(cacheFileUri, { idempotent: true }).catch(() => {});
      }
    }, estimatedDurationMs);

    return true;
  } catch (nativeErr) {
    console.warn('[Cartesia] Native audio playback error:', nativeErr);
    onError?.(nativeErr);
    return false;
  }
}
