// The one place this repo reads the environment. The live suite runs only when a key is present.
const key = process.env["OPENAI_API_KEY"];

export const OPENAI_API_KEY: string | undefined = key !== undefined && key.length > 0 ? key : undefined;
