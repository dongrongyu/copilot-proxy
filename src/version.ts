// Single source of truth for the app version is package.json. The build step
// injects it as a compile-time literal via `bun build --define` (see the
// "build" script in package.json), so this runtime code never imports the
// dependency manifest — mirroring how C# reads an injected assembly attribute
// rather than parsing the .csproj. Dev runs (`bun run src/index.ts`, no build)
// fall back to a dev marker.
declare const __APP_VERSION__: string;

export const VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0-dev";
