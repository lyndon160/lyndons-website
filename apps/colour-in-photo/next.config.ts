import type { NextConfig } from "next";

const isSitesBuild = process.env.npm_lifecycle_event?.endsWith(":sites") ?? false;

const nextConfig: NextConfig = {
  output: isSitesBuild ? undefined : "export",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
