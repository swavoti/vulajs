import React from 'react';
import { VulaLink } from '../src/vula';

export default function Home() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '2rem', backgroundColor: '#0f172a', color: '#f8fafc', fontFamily: 'system-ui, sans-serif' }}>
      
      {/* Vula Logo / Hero */}
      <div style={{ marginBottom: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ width: '100px', height: '100px', borderRadius: '24px', background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1.5rem', boxShadow: '0 10px 25px -5px rgba(139, 92, 246, 0.5)' }}>
          <span style={{ fontSize: '3rem', fontWeight: 'bold', color: 'white' }}>V</span>
        </div>
        <h1 style={{ fontSize: '3.5rem', fontWeight: '800', margin: '0', background: '-webkit-linear-gradient(0deg, #60a5fa, #c084fc)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Vula.js
        </h1>
        <h2 style={{ fontSize: '1.5rem', fontWeight: '500', color: '#94a3b8', marginTop: '0.5rem', margin: '0' }}>
          Swavoti/vulajs
        </h2>
      </div>

      {/* Introduction */}
      <p style={{ fontSize: '1.25rem', color: '#cbd5e1', textAlign: 'center', maxWidth: '600px', lineHeight: '1.6', marginBottom: '3rem' }}>
        The blazingly fast, minimal file-based React framework powered by Rspack. 
        Experience instant hot module replacement, zero-config SSR, and beautiful out-of-the-box defaults.
      </p>
      
      {/* Call to Actions */}
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <a href="https://github.com/nguyenblacks/vulajs" target="_blank" rel="noreferrer" style={{ padding: '1rem 2rem', backgroundColor: '#3b82f6', borderRadius: '9999px', textDecoration: 'none', color: '#ffffff', fontWeight: '600', fontSize: '1.125rem', transition: 'background-color 0.2s', boxShadow: '0 4px 6px -1px rgba(59, 130, 246, 0.4)' }}>
        <a href="https://github.com/swavoti/vulajs" target="_blank" rel="noreferrer" style={{ padding: '1rem 2rem', backgroundColor: '#3b82f6', borderRadius: '9999px', textDecoration: 'none', color: '#ffffff', fontWeight: '600', fontSize: '1.125rem', transition: 'background-color 0.2s', boxShadow: '0 4px 6px -1px rgba(59, 130, 246, 0.4)' }}>
          View Docs on GitHub
        </a>
        <a href="/api/hello" style={{ padding: '1rem 2rem', backgroundColor: 'transparent', border: '2px solid #475569', borderRadius: '9999px', textDecoration: 'none', color: '#f8fafc', fontWeight: '600', fontSize: '1.125rem', transition: 'border-color 0.2s' }}>
          Test API Route
        </a>
        <VulaLink page="/about" style={{ padding: '1rem 2rem', backgroundColor: 'transparent', border: '2px solid #475569', borderRadius: '9999px', textDecoration: 'none', color: '#f8fafc', fontWeight: '600', fontSize: '1.125rem' }}>
          Try Vula navigation
        </VulaLink>
      </div>
      
    </div>
  );
}
