import type { Metadata } from "next";
import Image from "next/image";

import { OfflineActions } from "@/src/platform/pwa/OfflineActions";

export const metadata: Metadata = {
  title: "离线 | Lexicon Workbench",
};

export default function OfflinePage() {
  return (
    <main className="pwa-offline-page">
      <header className="pwa-offline-brand">
        <Image
          src="/brand-mark.svg"
          width={64}
          height={64}
          alt=""
          priority
        />
        <strong>Lexicon Workbench</strong>
      </header>
      <section className="pwa-offline-content">
        <div>
          <h1>当前无法连接词典服务</h1>
          <p>收藏、历史和笔记仍保存在这台设备上。重新联网后即可继续查询词条、图片和读音。</p>
          <OfflineActions />
        </div>
      </section>
    </main>
  );
}
