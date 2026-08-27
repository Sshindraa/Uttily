import { useCallback, useEffect, useRef, useState } from 'react';

export interface CameraState {
  stream: MediaStream | null;
  isLoading: boolean;
  error: string | null;
  isSupported: boolean;
}

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920, min: 1280 },
    height: { ideal: 1080, min: 720 },
  },
};

export function useCamera(autoStart = true) {
  const [state, setState] = useState<CameraState>({
    stream: null,
    isLoading: autoStart,
    error: null,
    isSupported: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
  });

  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setState((prev) => ({ ...prev, stream: null, isLoading: false }));
  }, []);

  const startCamera = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        isSupported: false,
        error: 'Caméra non disponible sur ce navigateur.',
      }));
      return;
    }

    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    stopCamera();

    try {
      const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      streamRef.current = stream;
      setState({
        stream,
        isLoading: false,
        error: null,
        isSupported: true,
      });
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error && err.name === 'NotAllowedError'
          ? "Accès à la caméra refusé. Utilisez l'import de fichier."
          : 'Impossible de démarrer le flux caméra.';
      setState({
        stream: null,
        isLoading: false,
        error: errorMessage,
        isSupported: true,
      });
    }
  }, [stopCamera]);

  useEffect(() => {
    if (autoStart) {
      void startCamera();
    }
    return () => {
      stopCamera();
    };
  }, [autoStart, startCamera, stopCamera]);

  return {
    stream: state.stream,
    isLoading: state.isLoading,
    error: state.error,
    isSupported: state.isSupported,
    startCamera,
    stopCamera,
  };
}
