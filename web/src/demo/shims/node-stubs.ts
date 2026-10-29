export const existsSync = () => false;
export const mkdirSync = () => undefined;
export const readFileSync = () => "";
export const resolve = (p: string) => p;
export const dirname = (p: string) => p;
export const join = (...p: string[]) => p.join("/");
export default { existsSync, mkdirSync, readFileSync, resolve, dirname, join };
