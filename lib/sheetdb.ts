export type SheetDBConfig = {
  apiUrl: string;
  apiKey?: string;
  timeout: number;
};

export class SheetDB {
  private config: SheetDBConfig;
  constructor() {
    this.config = {
      apiUrl: process.env.SHEETDB_ENDPOINT ?? "",
      apiKey: process.env.SHEETDB_API_KEY || undefined,
      timeout: 5000,
    };
  }
}
