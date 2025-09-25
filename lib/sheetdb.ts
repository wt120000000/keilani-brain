export type SheetDBConfig = {
  apiUrl: string;
  timeout: number;
  apiKey?: string; // optional, but if present must be string
};

export class SheetDB {
  private config: SheetDBConfig;
  constructor() {
    const apiUrl = process.env.SHEETDB_ENDPOINT ?? "";
    const key = process.env.SHEETDB_API_KEY;

    const base: SheetDBConfig = {
      apiUrl,
      timeout: 5000,
    };

    if (key) {
      base.apiKey = key; // only add when defined
    }

    this.config = base;
  }
}
