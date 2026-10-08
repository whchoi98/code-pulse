export function releaseDocuments(root: string): Promise<{ version: string; files: Map<string, string> }>;
export function syncReleaseDocuments(root: string, check?: boolean, tag?: string): Promise<{
  version: string;
  files: string[];
  mode: 'check' | 'sync';
}>;
