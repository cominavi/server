export function initializeConventionFloor(): void {
  const canvas = document.querySelector<HTMLCanvasElement>(
    "[data-convention-floor]",
  );
  if (!canvas || canvas.dataset.initialized === "true") return;
  canvas.dataset.initialized = "true";

  const context = canvas.getContext("2d", { alpha: false });
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const camera = { x: 0, y: 0 };
  let width = 0;
  let height = 0;
  let animationFrame = 0;
  let previousTime = 0;
  const panSpeed = 10;

  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(Math.max(value, minimum), maximum);

  const metrics = () => {
    const tableShortSide = clamp(width / 72, 4.6, 7.5);
    const tableLongSide = tableShortSide * 2.65;
    const tableSpacing = tableShortSide * 0.32;
    const tablesPerBank = 10;
    const endCapGap = tableShortSide * 2;
    const narrowAisle = tableLongSide * 1.2;
    const bigAisle = tableLongSide * 3.25;
    const blockWidth = tableLongSide * 2 + endCapGap;
    const bankLength =
      tablesPerBank * tableLongSide + (tablesPerBank - 1) * tableSpacing;
    const blockHeight = bankLength + tableShortSide * 2;

    return {
      tableShortSide,
      tableLongSide,
      tableSpacing,
      tablesPerBank,
      blockWidth,
      blockHeight,
      horizontalStride: blockWidth + narrowAisle,
      verticalStride: blockHeight + bigAisle,
    };
  };

  const addTableBlock = (
    originX: number,
    originY: number,
    floor: ReturnType<typeof metrics>,
  ) => {
    const {
      tableShortSide,
      tableLongSide,
      tableSpacing,
      tablesPerBank,
      blockWidth,
      blockHeight,
    } = floor;
    const rightBankX = originX + blockWidth - tableShortSide;
    const bankStartY = originY + tableShortSide;
    const endCapStartX = originX + (blockWidth - tableLongSide * 2) / 2;

    for (let table = 0; table < tablesPerBank; table += 1) {
      const tableY = bankStartY + table * (tableLongSide + tableSpacing);
      context?.rect(originX, tableY, tableShortSide, tableLongSide);
      context?.rect(rightBankX, tableY, tableShortSide, tableLongSide);
    }

    for (const endY of [originY, originY + blockHeight - tableShortSide]) {
      context?.rect(endCapStartX, endY, tableLongSide, tableShortSide);
      context?.rect(
        endCapStartX + tableLongSide,
        endY,
        tableLongSide,
        tableShortSide,
      );
    }
  };

  const render = () => {
    if (!context || width === 0 || height === 0) return;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const floor = metrics();
    const drawingRadius = Math.hypot(width, height) * 0.72;
    const minimumX = camera.x - drawingRadius;
    const maximumX = camera.x + drawingRadius;
    const minimumY = camera.y - drawingRadius;
    const maximumY = camera.y + drawingRadius;
    const startColumn = Math.floor(minimumX / floor.horizontalStride) - 1;
    const endColumn = Math.ceil(maximumX / floor.horizontalStride) + 1;
    const startRow = Math.floor(minimumY / floor.verticalStride) - 1;
    const endRow = Math.ceil(maximumY / floor.verticalStride) + 1;

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.save();
    context.translate(width / 2, height / 2);
    context.rotate(-Math.PI / 12);
    context.translate(-camera.x, -camera.y);
    context.beginPath();

    for (let row = startRow; row <= endRow; row += 1) {
      for (let column = startColumn; column <= endColumn; column += 1) {
        addTableBlock(
          column * floor.horizontalStride,
          row * floor.verticalStride,
          floor,
        );
      }
    }

    context.strokeStyle = "rgba(75, 85, 99, 0.58)";
    context.lineWidth = 1.45;
    context.stroke();
    context.restore();
  };

  const animate = (time: number) => {
    const deltaTime = Math.min(
      Math.max((time - previousTime) / 1000, 0),
      1 / 15,
    );
    previousTime = time;
    camera.y = (camera.y + panSpeed * deltaTime) % metrics().verticalStride;
    render();
    animationFrame = window.requestAnimationFrame(animate);
  };

  const startAnimation = () => {
    window.cancelAnimationFrame(animationFrame);
    previousTime = performance.now();

    if (reduceMotion.matches) {
      camera.x = 0;
      camera.y = 0;
      render();
      return;
    }

    if (document.hidden) {
      render();
      return;
    }

    animationFrame = window.requestAnimationFrame(animate);
  };

  const resize = () => {
    const bounds = canvas.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    render();
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  reduceMotion.addEventListener("change", startAnimation);
  document.addEventListener("visibilitychange", startAnimation);
  resize();
  startAnimation();
}
