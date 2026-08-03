import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root explicitly: Turbopack otherwise walks up from this
  // repo looking for the nearest lockfile and can pick up an unrelated one
  // from a parent directory (e.g. a stray lockfile in $HOME), which is
  // environment-dependent and not reproducible across machines.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
