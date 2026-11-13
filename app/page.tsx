import React, { useState } from 'react';
import { VulaCache } from '../src/cache';
import { Vula } from '../src/vula';

export default function RootPage() {
  const [apiResponse, setApiResponse] = useState<any>(null);
  const [count, setCount] = useState(0);

  const callApi = async () => {
    try {
      const data = await Vula.api('hello');
      setApiResponse(data);
    } catch (err) {
      setApiResponse({ error: String(err) });
    }
  };

  const callServerComponent = async () => {
    try {
      const result = await Vula.server('api/counter', count);
      setCount(result);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: "'Outfit', system-ui, sans-serif", padding: '2rem' }}>
      <VulaCache />

      <header style={{ maxWidth: '800px', margin: '4rem auto', textAlign: 'center' }}>
        <h1 style={{ fontSize: '3rem', fontWeight: 900, marginBottom: '0.5rem' }}>
          Vula.js
        </h1>
        <p style={{ color: '#888', fontSize: '1.1rem' }}>
          Create a file in <code style={{ background: '#1a1a2e', padding: '2px 8px', borderRadius: '4px' }}>/app</code> and it becomes a route.
        </p>
      </header>

      <main style={{ maxWidth: '800px', margin: '0 auto', display: 'grid', gap: '1.5rem' }}>

        <section style={{ background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '1.5rem' }}>
          <h2 style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#666', marginBottom: '1rem' }}>API Route</h2>
          <p style={{ color: '#999', marginBottom: '1rem', fontSize: '0.9rem' }}>
            Calls <code style={{ background: '#1a1a2e', padding: '2px 6px', borderRadius: '4px' }}>GET /api/hello</code> — defined in <code style={{ background: '#1a1a2e', padding: '2px 6px', borderRadius: '4px' }}>app/api/hello.ts</code>
          </p>
          <button
            onClick={callApi}
            style={{ padding: '0.6rem 1.5rem', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700 }}
          >
            Call API
          </button>
          {apiResponse && (
            <pre style={{ marginTop: '1rem', background: '#0d0d0d', padding: '1rem', borderRadius: '8px', fontSize: '0.85rem', overflow: 'auto' }}>
              {JSON.stringify(apiResponse, null, 2)}
            </pre>
          )}
        </section>

        <section style={{ background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '1.5rem' }}>
          <h2 style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#666', marginBottom: '1rem' }}>Server Component</h2>
          <p style={{ color: '#999', marginBottom: '1rem', fontSize: '0.9rem' }}>
            Runs <code style={{ background: '#1a1a2e', padding: '2px 6px', borderRadius: '4px' }}>counter.sever.comp.ts</code> on the server, returns the result to the client.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
            <span style={{ fontSize: '2.5rem', fontWeight: 900 }}>{count}</span>
            <button
              onClick={callServerComponent}
              style={{ padding: '0.6rem 1.5rem', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700 }}
            >
              Run on Server
            </button>
          </div>
        </section>

      </main>

      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700;900&display=swap" rel="stylesheet" />
    </div>
  );
}
