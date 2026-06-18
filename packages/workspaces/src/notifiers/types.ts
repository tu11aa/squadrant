export interface NotifierProbeResult {
  installed: boolean;
  reachable: boolean;
}

export interface NotifierScope {
  [key: string]: unknown;
}

export interface NotifierDriver {
  name: string;

  probe(): Promise<NotifierProbeResult>;
  notify(message: string): Promise<void>;
}

export type NotifierFactory = (scope: NotifierScope) => NotifierDriver;
