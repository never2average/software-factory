interface Options { name?: string | null; suffix?: string | null; isolated?: boolean | null }
interface PathOptions { isolated?: boolean | null }
interface XdgAppPaths {
  (options?: string | Options): XdgAppPaths;
  $name(): string;
  $isolated(): boolean;
  cache(options?: PathOptions): string;
  config(options?: PathOptions): string;
  data(options?: PathOptions): string;
  state(options?: PathOptions): string;
  runtime(options?: PathOptions): string | undefined;
  configDirs(options?: PathOptions): string[];
  dataDirs(options?: PathOptions): string[];
}
declare const paths: XdgAppPaths;
export = paths;
