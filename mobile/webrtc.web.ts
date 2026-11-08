export const mediaDevices = typeof navigator !== 'undefined' && 'mediaDevices' in navigator ? {
  getUserMedia: (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints),
} : null;

export const RTCPeerConnection = typeof window !== 'undefined' ? window.RTCPeerConnection : class {} as any;
export const RTCIceCandidate = typeof window !== 'undefined' ? window.RTCIceCandidate : class {} as any;
export const RTCSessionDescription = typeof window !== 'undefined' ? window.RTCSessionDescription : class {} as any;
