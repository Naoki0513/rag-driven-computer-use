import { getCsvSchemaString } from './duckdb.js';

export async function getDatabaseSchemaString(): Promise<string> {
  return await getCsvSchemaString();
}


