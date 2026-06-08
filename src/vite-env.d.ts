/// <reference types="vite/client" />

// Vite `?inline` CSS imports return the stylesheet as a string (used to mount the meet
// design system only while the native Meeting view is open — see MeetLive).
declare module "*.css?inline" {
  const css: string;
  export default css;
}
