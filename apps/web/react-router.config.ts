import type { Config } from '@react-router/dev/config';
import { vercelPreset } from '@vercel/react-router/vite';

/** On Vercel (`VERCEL=1` during builds) the preset emits serverless functions; elsewhere the plain Node server build. */
export default {
  appDirectory: 'app',
  ssr: true,
  presets: process.env.VERCEL ? [vercelPreset()] : [],
} satisfies Config;
