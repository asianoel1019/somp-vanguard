import React, { useEffect, useRef } from 'react';

const MatrixRain = () => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    const setCanvasSize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    setCanvasSize();
    window.addEventListener('resize', setCanvasSize);

    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()';
    const fontSize = 16;
    let columns = Math.floor(canvas.width / fontSize);
    let drops = Array(columns).fill(1);

    // Reinitialize drops on resize
    const handleResizeDrops = () => {
      columns = Math.floor(canvas.width / fontSize);
      drops = Array(columns).fill(1);
    };
    window.addEventListener('resize', handleResizeDrops);

    const draw = () => {
      // Create trailing effect
      ctx.fillStyle = 'rgba(2, 6, 23, 0.08)'; // Matches background --bg-primary
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = '#85ff51'; // Matches --accent-primary
      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < drops.length; i++) {
        const text = characters.charAt(Math.floor(Math.random() * characters.length));
        ctx.fillText(text, i * fontSize, drops[i] * fontSize);

        if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i]++;
      }
    };

    const intervalId = setInterval(draw, 50);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('resize', setCanvasSize);
      window.removeEventListener('resize', handleResizeDrops);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 0, // Behind everything
        pointerEvents: 'none',
        opacity: 0.4 // Faded significantly
      }}
    />
  );
};

export default MatrixRain;
