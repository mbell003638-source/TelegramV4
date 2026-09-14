/**
 * HandTracker — MediaPipe HandLandmarker integration for 3D globe gesture control
 * 
 * Uses @mediapipe/tasks-vision.
 * Provides single-hand pinch-to-rotate and dual-hand pinch-to-zoom.
 */

// Landmark indices
const THUMB_TIP = 4;
const INDEX_TIP = 8;

export interface HandLandmark {
  x: number;
  y: number;
  z: number;
}

export interface HandResult {
  landmarks: HandLandmark[][];
  handedness?: { categoryName: string }[][];
}

export interface GestureState {
  handsDetected: number;
  isPinching: boolean;
  isDualPinching: boolean;
  pinchDeltaX: number;
  pinchDeltaY: number;
  zoomDelta: number;
  pinchCenterX: number;
  pinchCenterY: number;
}

type GestureCallback = (state: GestureState) => void;

export class HandTracker {
  private handLandmarker: any = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private animFrameId: number | null = null;
  private running = false;
  private callback: GestureCallback | null = null;
  
  private prevPinchCenter = { x: 0, y: 0 };
  private prevDualDistance = 0;
  private hasPrevPinch = false;
  private hasPrevDual = false;

  private static readonly PINCH_THRESHOLD = 0.07;
  private static readonly WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
  private static readonly MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  async initialize(): Promise<void> {
    if (this.handLandmarker) return;

    try {
      const { HandLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
      
      const filesetResolver = await FilesetResolver.forVisionTasks(HandTracker.WASM_CDN);

      this.handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: HandTracker.MODEL_PATH,
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
    } catch (err) {
      console.error('Failed to initialize HandLandmarker:', err);
      throw new Error('MediaPipe initialization failed.');
    }
  }

  async start(videoElement: HTMLVideoElement, cb: GestureCallback): Promise<void> {
    if (!this.handLandmarker) {
      await this.initialize();
    }

    this.video = videoElement;
    this.callback = cb;
    this.hasPrevPinch = false;
    this.hasPrevDual = false;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 320, height: 240 }
      });
      videoElement.srcObject = this.stream;
      await videoElement.play();
      this.running = true;
      this.detectLoop();
    } catch (err) {
      console.error('Camera access denied:', err);
      throw new Error('Camera permission denied');
    }
  }

  stop(): void {
    this.running = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
    this.hasPrevPinch = false;
    this.hasPrevDual = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  private detectLoop(): void {
    if (!this.running || !this.video || !this.handLandmarker || !this.callback) return;

    const video = this.video;
    if (video.readyState >= 2) {
      try {
        const results = this.handLandmarker.detectForVideo(video, performance.now());
        const state = this.processResults(results);
        this.callback(state);
      } catch (e) {
        // frame skip
      }
    }

    this.animFrameId = requestAnimationFrame(() => this.detectLoop());
  }

  private processResults(results: HandResult): GestureState {
    const state: GestureState = {
      handsDetected: results.landmarks?.length || 0,
      isPinching: false,
      isDualPinching: false,
      pinchDeltaX: 0,
      pinchDeltaY: 0,
      zoomDelta: 0,
      pinchCenterX: 0.5,
      pinchCenterY: 0.5,
    };

    if (!results.landmarks || results.landmarks.length === 0) {
      this.hasPrevPinch = false;
      this.hasPrevDual = false;
      return state;
    }

    const hands = results.landmarks;
    const pinchStates = hands.map(hand => {
      const thumb = hand[THUMB_TIP];
      const index = hand[INDEX_TIP];
      if (!thumb || !index) return { isPinching: false, centerX: 0.5, centerY: 0.5, dist: 1 };
      
      const dist = Math.sqrt(
        (thumb.x - index.x) ** 2 + 
        (thumb.y - index.y) ** 2 + 
        (thumb.z - index.z) ** 2
      );
      const isPinching = dist < HandTracker.PINCH_THRESHOLD;
      const centerX = (thumb.x + index.x) / 2;
      const centerY = (thumb.y + index.y) / 2;
      return { isPinching, centerX, centerY, dist };
    });

    // Dual hand pinch zoom
    if (hands.length >= 2 && pinchStates[0].isPinching && pinchStates[1].isPinching) {
      state.isDualPinching = true;
      state.isPinching = true;
      
      const dualDist = Math.sqrt(
        (pinchStates[0].centerX - pinchStates[1].centerX) ** 2 +
        (pinchStates[0].centerY - pinchStates[1].centerY) ** 2
      );

      if (this.hasPrevDual) {
        state.zoomDelta = (dualDist - this.prevDualDistance) * 8;
      }
      this.prevDualDistance = dualDist;
      this.hasPrevDual = true;
      this.hasPrevPinch = false;
      return state;
    }

    this.hasPrevDual = false;

    // Single hand pinch rotate
    if (pinchStates.length > 0 && pinchStates[0].isPinching) {
      state.isPinching = true;
      state.pinchCenterX = pinchStates[0].centerX;
      state.pinchCenterY = pinchStates[0].centerY;

      if (this.hasPrevPinch) {
        state.pinchDeltaX = -(pinchStates[0].centerX - this.prevPinchCenter.x) * 5;
        state.pinchDeltaY = (pinchStates[0].centerY - this.prevPinchCenter.y) * 5;
      }

      this.prevPinchCenter = { x: pinchStates[0].centerX, y: pinchStates[0].centerY };
      this.hasPrevPinch = true;
    } else {
      this.hasPrevPinch = false;
    }

    return state;
  }

  destroy(): void {
    this.stop();
    this.handLandmarker = null;
  }
}
