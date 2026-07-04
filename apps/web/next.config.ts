import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The web UI is a thin projection of the rendezvous server. It never reads
  // the git log directly; every call proxies through app/api/kanon/* so the
  // API key stays server-side (the browser never sees it).
  poweredByHeader: false,
};

export default config;
