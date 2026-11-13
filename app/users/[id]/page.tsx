import React from 'react';

export default function UserProfile({ params }: { params: { id: string } }) {
  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>User Profile</h1>
      <p>Dynamic User ID: <strong>{params.id}</strong></p>
    </div>
  );
}
