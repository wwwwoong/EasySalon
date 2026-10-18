import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "이지 살롱 | 작은 미용실의 편안한 하루",
  description: "QR 접수부터 대기 안내, 매장 운영까지. 손길에 집중할 수 있도록 이지 살롱이 함께합니다.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
