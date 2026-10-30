import React, { useEffect, useRef } from 'react';

const SunlightDust = () => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let animationFrameId;

    const setCanvasSize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    setCanvasSize();
    window.addEventListener('resize', setCanvasSize);

    const dustParticles = [];
    const numParticles = 80;

    for (let i = 0; i < numParticles; i++) {
      dustParticles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        radius: Math.random() * 4 + 1,
        vx: (Math.random() - 0.5) * 0.4, // Drift left/right
        vy: Math.random() * -0.6 - 0.1,  // Drift slowly upwards
        alpha: Math.random() * 0.5 + 0.1,
        fadeSpeed: (Math.random() - 0.5) * 0.01 // Pulsing glow
      });
    }

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      dustParticles.forEach(p => {
        // Update positions
        p.x += p.vx;
        p.y += p.vy;
        p.alpha += p.fadeSpeed;

        if (p.alpha > 0.6) p.fadeSpeed *= -1;
        if (p.alpha < 0.1) p.fadeSpeed *= -1;

        // Reset if out of bounds
        if (p.y < -10) {
          p.y = canvas.height + 10;
          p.x = Math.random() * canvas.width;
        }
        if (p.x < -10) p.x = canvas.width + 10;
        if (p.x > canvas.width + 10) p.x = -10;

        // Draw dust particle
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        
        // Warm golden hue: #B58900
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius);
        gradient.addColorStop(0, `rgba(255, 220, 100, ${p.alpha})`);
        gradient.addColorStop(1, `rgba(181, 137, 0, 0)`);
        
        ctx.fillStyle = gradient;
        ctx.fill();
      });

      animationFrameId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', setCanvasSize);
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
        zIndex: 0,
        pointerEvents: 'none',
        opacity: 0.9
      }}
    />
  );
};

export default SunlightDust;
