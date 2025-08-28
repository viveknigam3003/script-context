export interface ViteImportMeta {
  env: {
    BASE_URL?: string;
    [key: string]: string | boolean | undefined;
  };
}
