import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Chutes E2EE Chat',
  description: 'End-to-end encrypted chat via Chutes.ai TEE',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
