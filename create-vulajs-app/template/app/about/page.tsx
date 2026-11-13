import React from 'react';
import { VulaLink } from '../../src/vula';

export default function About() {
  return (
    <main style={{ minHeight: '100vh', padding: '3rem', backgroundColor: '#0f172a', color: '#f8fafc', fontFamily: 'system-ui, sans-serif' }}>
      <h1>About this Vula app</h1>
      <p>This page was requested from the server and its client chunk was loaded on demand.</p>
      <VulaLink page="/">Back home</VulaLink>
    </main>
  );
}
