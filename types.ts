
export type LogEntry = {
  id: number;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
};

export type ProcessingState = 'idle' | 'processing' | 'success' | 'error';
