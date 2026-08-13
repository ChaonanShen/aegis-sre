import React from 'react';
import { Construction } from 'lucide-react';

export function FeaturePendingPage({ title }: { title: string }) {
  return (
    <main className="feature-pending" data-testid="feature-pending">
      <Construction aria-hidden size={28} />
      <h1>{title}</h1>
      <p>真实模式尚未接通，演示数据已隐藏。</p>
    </main>
  );
}
