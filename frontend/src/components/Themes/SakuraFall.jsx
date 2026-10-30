import React, { useEffect, useRef } from 'react';

const SakuraFall = () => {
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

    const petals = [];
    const numPetals = 50;

    for (let i = 0; i < numPetals; i++) {
      petals.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        size: Math.random() * 5 + 4,
        speedY: Math.random() * 1 + 0.5,
        speedX: Math.random() * 1.5 - 0.75,
        angle: Math.random() * Math.PI * 2,
        spin: Math.random() * 0.05 - 0.025,
        opacity: Math.random() * 0.6 + 0.3
      });
    }

    const drawPetal = (p) => {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      
      ctx.beginPath();
      // Draw a gentle sakura petal curve
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-p.size, -p.size * 1.2, -p.size * 1.5, p.size / 3, 0, p.size);
      ctx.bezierCurveTo(p.size * 1.5, p.size / 3, p.size, -p.size * 1.2, 0, 0);
      
      // Add a slight gradient or solid soft pink
      ctx.fillStyle = `rgba(255, 141, 161, ${p.opacity})`; // Matches --accent-primary
      ctx.fill();
      ctx.restore();
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      petals.forEach(p => {
        drawPetal(p);

        // Update positions
        p.y += p.speedY;
        p.x += Math.sin(p.angle) * p.speedX;
        p.angle += p.spin;

        // Reset if it goes out of bounds
        if (p.y > canvas.height + p.size * 2) {
          p.y = -p.size * 2;
          p.x = Math.random() * canvas.width;
          p.speedX = Math.random() * 1.5 - 0.75;
        }
        if (p.x > canvas.width + p.size * 2) {
          p.x = -p.size * 2;
        } else if (p.x < -p.size * 2) {
          p.x = canvas.width + p.size * 2;
        }
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
        zIndex: 0, // Behind everything
        pointerEvents: 'none',
        opacity: 0.85
      }}
    />
  );
};

export default SakuraFall;
