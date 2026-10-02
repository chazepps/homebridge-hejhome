declare const __PLUGIN_VERSION__: string;
declare module '*.css';

declare module '*.png' {
  const url: string;
  export default url;
}
