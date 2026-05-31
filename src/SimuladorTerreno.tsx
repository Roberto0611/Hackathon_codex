import { useState, useEffect, useRef, useCallback } from 'react';

const CELL_TYPES = {
  NORMAL: { id: 'NORMAL', color: '#8B5E3C', emoji: '🟫', k: 30, name: 'Normal' },
  LODO: { id: 'LODO', color: '#4a3728', emoji: '💧', k: 80, name: 'Lodo' },
  PIEDRA: { id: 'PIEDRA', color: '#6b6b6b', emoji: '🪨', k: 110, name: 'Piedra' },
  HIERBA: { id: 'HIERBA', color: '#7db356', emoji: '🌿', k: 20, name: 'Hierba' },
  SECO: { id: 'SECO', color: '#c4a882', emoji: '☀️', k: 15, name: 'Seco' },
  INUNDADO: { id: 'INUNDADO', color: '#2c5f8a', emoji: '🌊', k: 120, name: 'Inundado' }
};

// --- NÚCLEO IA · Parámetros de control predictivo ---
const LOOKAHEAD = 4;   // celdas que la IA escanea hacia adelante
const EASE_STEP = 2;   // cm máximo de ajuste de profundidad por tick

// Amperaje resultante para una profundidad (cm) dada en un suelo de resistencia k
function ampForDepth(k: number, a: number, n: number, v: number, eff: number, volt: number, d: number) {
  const R_N = k * a * (d / 100) * n * 1000;
  const v_ms = v / 3.6;
  const P_watts = (R_N * v_ms) / eff;
  return P_watts / volt;
}

// Profundidad máxima (cm) que mantiene el amperaje bajo el límite en un suelo k
// El amperaje es lineal en d, así que se despeja directamente: amp = coef * d
function safeDepth(k: number, a: number, n: number, v: number, eff: number, volt: number, maxI: number) {
  const v_ms = v / 3.6;
  const coef = (k * a * n * 1000 * v_ms) / eff / volt / 100;
  if (coef <= 0) return 40;
  return maxI / coef;
}

// Próximas `count` celdas según el patrón boustrophedon (mismo que stepSimulation)
function nextCells(x: number, y: number, mapSize: number, count: number) {
  const cells: { x: number; y: number }[] = [];
  let cx = x, cy = y;
  for (let i = 0; i < count; i++) {
    const evenRow = cy % 2 === 0;
    if (evenRow) { if (cx < mapSize - 1) cx++; else cy++; }
    else { if (cx > 0) cx--; else cy++; }
    if (cy >= mapSize) break;
    cells.push({ x: cx, y: cy });
  }
  return cells;
}

export default function SimuladorTerreno({ onTick }: { onTick?: (estado: any) => void }) {
  // Configuración del mapa y editor
  const [mapSize, setMapSize] = useState(10);
  const [grid, setGrid] = useState<string[][]>([]);
  const [activeBrush, setActiveBrush] = useState<string>('NORMAL');
  const [isDrawing, setIsDrawing] = useState(false);

  // Estados de simulación
  const [simState, setSimState] = useState<'IDLE' | 'RUNNING' | 'PAUSED' | 'FINISHED'>('IDLE');
  const [tractorPos, setTractorPos] = useState({ x: 0, y: 0 });
  const [history, setHistory] = useState<Record<string, { amperaje: number; profundidad_usada: number }>>({});
  const [stats, setStats] = useState({
    ajustes: 0,
    preajustes: 0,
    kwhAcumulados: 0,
    amperajeActual: 0,
    profundidadActual: 20,
    recomendada: 20,
    kwhAhorrados: 0,
    bateria: 50 // Reducido de 150 a 50 kWh para consumo más visible
  });

  // Parámetros de simulación
  const [paramA, setParamA] = useState(1.5);
  const [paramN, setParamN] = useState(4);
  const [paramD, setParamD] = useState(20);
  const [paramV, setParamV] = useState(8);
  const [paramVolt, setParamVolt] = useState(700);
  const [paramEff, setParamEff] = useState(0.85);
  const [paramMaxI, setParamMaxI] = useState(100);
  const [animSpeed, setAnimSpeed] = useState(3000); // 2000 lento, 1000 normal, 500 rapido

  const historyAmpArr = useRef<number[]>([]);

  // NÚCLEO IA: última predicción para visualización (celdas escaneadas, pico previsto)
  const [prediccion, setPrediccion] = useState<{
    amperajes: number[];
    celdas: { x: number; y: number }[];
    picoPrevisto: number;
    dObjetivo: number;
    preajuste: boolean;
  } | null>(null);

  // Inicializar grid
  useEffect(() => {
    if (simState === 'IDLE') {
      const newGrid = Array(mapSize).fill(0).map(() => Array(mapSize).fill('NORMAL'));
      setGrid(newGrid);
      setHistory({});
      setTractorPos({ x: 0, y: 0 });
      setStats({
        ajustes: 0,
        preajustes: 0,
        kwhAcumulados: 0,
        amperajeActual: 0,
        profundidadActual: paramD,
        recomendada: paramD,
        kwhAhorrados: 0,
        bateria: 50 // Reducido de 150 a 50 kWh para consumo más visible
      });
      historyAmpArr.current = [];
      setPrediccion(null);
    }
  }, [mapSize, simState]);

  // --- PLANIFICADOR DE JORNADA: publicar el diseño del lote ---
  // Mientras se diseña el terreno (IDLE), publica un resumen por tipo de suelo
  // y los parámetros actuales para que el dashboard planifique sobre el lote REAL.
  useEffect(() => {
    if (grid.length === 0) return;
    const conteo: Record<string, number> = {};
    grid.forEach(row => row.forEach(cell => { conteo[cell] = (conteo[cell] || 0) + 1; }));

    const zonas = Object.entries(conteo).map(([id, celdas]) => {
      const tipo = CELL_TYPES[id as keyof typeof CELL_TYPES];
      return { tipo: tipo.name, celdas, k: tipo.k };
    }).sort((a, b) => a.k - b.k);

    const planLote = {
      zonas,
      celdasTotales: mapSize * mapSize,
      params: { a: paramA, n: paramN, v: paramV, volt: paramVolt, eff: paramEff, maxI: paramMaxI },
      profundidadRecomendada: paramD,
      ts: Date.now()
    };

    try {
      localStorage.setItem('plan_lote', JSON.stringify(planLote));
    } catch (e) {
      console.error("Error writing plan_lote", e);
    }
  }, [grid, mapSize, paramA, paramN, paramV, paramVolt, paramEff, paramMaxI, paramD]);

  // Generar aleatorio
  const randomizeGrid = () => {
    if (simState !== 'IDLE') return;
    const newGrid = Array(mapSize).fill(0).map(() => 
      Array(mapSize).fill(0).map(() => {
        const rand = Math.random();
        if (rand < 0.40) return 'NORMAL';
        if (rand < 0.60) return 'HIERBA';
        if (rand < 0.75) return 'SECO';
        if (rand < 0.85) return 'LODO';
        if (rand < 0.95) return 'PIEDRA';
        return 'INUNDADO';
      })
    );
    setGrid(newGrid);
  };

  const limpiarGrid = () => {
    if (simState !== 'IDLE') return;
    const newGrid = Array(mapSize).fill(0).map(() => Array(mapSize).fill('NORMAL'));
    setGrid(newGrid);
  };

  // Pintar celda
  const handleCellInteract = (y: number, x: number) => {
    if (simState !== 'IDLE') return;
    const newGrid = [...grid];
    newGrid[y] = [...newGrid[y]];
    newGrid[y][x] = activeBrush;
    setGrid(newGrid);
  };

  // Lógica de simulación de 1 tick
  const stepSimulation = useCallback(() => {
    setTractorPos(prev => {
      let { x, y } = prev;
      
      const isEvenRow = y % 2 === 0;
      if (isEvenRow) {
        if (x < mapSize - 1) x++;
        else y++;
      } else {
        if (x > 0) x--;
        else y++;
      }

      if (y >= mapSize) {
        // Parcela completada - calcular estadísticas
        const histAmperajes = Object.values(history).map(h => h.amperaje);
        const amperajeTotal = histAmperajes.reduce((sum, amp) => sum + amp, 0);
        const amperajePromedio = amperajeTotal / histAmperajes.length;
        
        // Calcular kWh total acumulado
        let kwhTotal = 0;
        Object.values(history).forEach(h => {
          const timeInHours = 0.001 / paramV;
          const kW = (h.amperaje * paramVolt) / 1000;
          kwhTotal += kW * timeInHours;
        });
        
        const estadisticasParcela = {
          amperajePromedio,
          amperajeTotal,
          celdasRecorridas: Object.keys(history).length,
          kwhTotal
        };
        
        // Calcular consumo promedio para horas restantes finales
        const finalAmperajes = Object.values(history).map(h => h.amperaje);
        const finalAmperajePromedio = finalAmperajes.reduce((sum, amp) => sum + amp, 0) / finalAmperajes.length;
        const consumoPromedioKw = (finalAmperajePromedio * paramVolt) / 1000;
        const horasRestantesFinales = stats.bateria > 0 ? stats.bateria / Math.max(0.1, consumoPromedioKw) : 0;
        
        const finalState = {
          parcelaCompletada: true,
          estadisticasParcela,
          posicion: prev,
          amperaje: { actual: stats.amperajeActual, optimo: 75, maximo: paramMaxI },
          profundidad: { actual: stats.profundidadActual, recomendada: paramD },
          velocidad: paramV,
          ajustes_automaticos: stats.ajustes,
          kwh_ahorrados: parseFloat(stats.kwhAhorrados.toFixed(2)),
          bateria: { 
            porcentaje: parseFloat(((stats.bateria/50)*100).toFixed(1)), // Cambiar de 150 a 50 kWh
            horas_restantes: parseFloat(horasRestantesFinales.toFixed(2))
          },
          historial_amperaje: [...historyAmpArr.current],
          mapa_terreno: grid,
          tractor_pos: prev,
          historial_mapa: history
        };
        
        try {
          localStorage.setItem('tractor_telemetry', JSON.stringify(finalState));
        } catch (e) {
          console.error("Error writing to localStorage", e);
        }
        
        setSimState('FINISHED');
        return prev;
      }

      const cellType = grid[y][x];
      const k = CELL_TYPES[cellType as keyof typeof CELL_TYPES].k;

      // --- NÚCLEO IA: CONTROL PREDICTIVO ---
      // 1. Escanear la ventana de celdas próximas y hallar la profundidad segura
      //    más restrictiva (la celda crítica que viene adelante).
      const ventana = [{ x, y }, ...nextCells(x, y, mapSize, LOOKAHEAD)];
      let dObjetivo = paramD; // aspiramos siempre a la profundidad recomendada
      ventana.forEach(c => {
        const kc = CELL_TYPES[grid[c.y][c.x] as keyof typeof CELL_TYPES].k;
        const dSafe = safeDepth(kc, paramA, paramN, paramV, paramEff, paramVolt, paramMaxI);
        if (dSafe < dObjetivo) dObjetivo = dSafe;
      });
      dObjetivo = Math.max(10, Math.min(paramD, dObjetivo));

      // 2. Mover la profundidad hacia el objetivo de forma gradual (anticipada).
      //    Baja antes de llegar al pico; recupera cuando el terreno se alivia.
      const dPrevia = stats.profundidadActual;
      let d_current = dPrevia;
      let preajuste = false;
      if (d_current > dObjetivo + 0.01) {
        d_current = Math.max(dObjetivo, d_current - EASE_STEP);
        preajuste = true;
      } else if (d_current < dObjetivo - 0.01) {
        d_current = Math.min(dObjetivo, d_current + EASE_STEP);
      }

      // 3. Amperaje real en la celda con la profundidad ya pre-ajustada.
      let amperaje = ampForDepth(k, paramA, paramN, paramV, paramEff, paramVolt, d_current);

      // 4. Salvaguarda reactiva: solo si el terreno excede lo previsto (overload real).
      let overloads = 0;
      let iterSafety = 10;
      while (amperaje > paramMaxI && d_current > 10 && iterSafety > 0) {
        d_current -= 2;
        amperaje = ampForDepth(k, paramA, paramN, paramV, paramEff, paramVolt, d_current);
        overloads++;
        iterSafety--;
      }
      const requiredAdjustments = overloads;

      // 5. Pronóstico para el dashboard: demanda prevista en las próximas celdas
      //    SI se operara a profundidad recomendada (la curva de riesgo a anticipar).
      const celdasFuturas = nextCells(x, y, mapSize, LOOKAHEAD);
      const prediccionAmp = celdasFuturas.map(c => {
        const kc = CELL_TYPES[grid[c.y][c.x] as keyof typeof CELL_TYPES].k;
        return parseFloat(ampForDepth(kc, paramA, paramN, paramV, paramEff, paramVolt, paramD).toFixed(2));
      });
      const picoPrevisto = prediccionAmp.length > 0 ? Math.max(...prediccionAmp) : 0;

      const cellKey = `${x},${y}`;
      setHistory(prevHist => ({
        ...prevHist,
        [cellKey]: { amperaje, profundidad_usada: d_current }
      }));

      // KWH = Power (kW) * Time (hours). 1 celda asume 1 metro
      // time (h) = distance (1m = 0.001km) / speed (km/h)
      // Multiplicador de 8x para hacer el consumo más visible en la demo
      const timeInHours = 0.001 / paramV;
      const kW = (amperaje * paramVolt) / 1000;
      const kWhThisCell = kW * timeInHours * 8; // Factor 8x para consumo más rápido y visible

      historyAmpArr.current.push(amperaje);
      if (historyAmpArr.current.length > 20) {
        historyAmpArr.current.shift();
      }

      setStats(prevStats => ({
        ajustes: prevStats.ajustes + requiredAdjustments,
        preajustes: (prevStats.preajustes || 0) + (preajuste ? 1 : 0),
        kwhAcumulados: prevStats.kwhAcumulados + kWhThisCell,
        amperajeActual: amperaje,
        profundidadActual: d_current,
        recomendada: paramD,
        kwhAhorrados: prevStats.kwhAhorrados + (requiredAdjustments * 0.15) + (preajuste ? 0.1 : 0),
        bateria: Math.max(0, prevStats.bateria - kWhThisCell) // Usar kWhThisCell que ya incluye el factor 8x
      }));

      const newAj = stats.ajustes + requiredAdjustments;
      const newAhorros = stats.kwhAhorrados + (requiredAdjustments * 0.15) + (preajuste ? 0.1 : 0);
      const newBat = Math.max(0, stats.bateria - kWhThisCell);
      
      // Calcular horas restantes de forma más realista
      // Horas = Batería restante (kWh) / Consumo promedio (kW)
      const consumoPromedioKw = kW; // Consumo actual en kW
      const horasRestantes = newBat > 0 ? newBat / Math.max(0.1, consumoPromedioKw) : 0;
      
      const newState = {
        parcelaCompletada: false,
        posicion: { x, y },
        amperaje: { actual: amperaje, optimo: 75, maximo: paramMaxI },
        profundidad: { actual: d_current, recomendada: paramD },
        velocidad: paramV,
        ajustes_automaticos: newAj,
        kwh_ahorrados: parseFloat(newAhorros.toFixed(2)),
        bateria: { 
          porcentaje: parseFloat(((newBat/50)*100).toFixed(1)), // Cambiar de 150 a 50 kWh
          horas_restantes: parseFloat(horasRestantes.toFixed(2))
        },
        historial_amperaje: [...historyAmpArr.current],
        // --- NÚCLEO IA: control predictivo ---
        prediccion: {
          amperajes: prediccionAmp,        // amperaje previsto en próximas celdas (a prof. recomendada)
          celdas: celdasFuturas,           // coords escaneadas hacia adelante
          picoPrevisto,                    // pico de amperaje anticipado
          dObjetivo: parseFloat(dObjetivo.toFixed(1)), // profundidad objetivo calculada por la IA
          preajuste                        // si en este tick la IA pre-ajustó anticipadamente
        },
        mapa_terreno: grid,
        tractor_pos: { x, y },
        historial_mapa: { ...history, [cellKey]: { amperaje, profundidad_usada: d_current } }
      };

      try {
        localStorage.setItem('tractor_telemetry', JSON.stringify(newState));
      } catch (e) {
        console.error("Error writing to localStorage", e);
      }

      setPrediccion(newState.prediccion);

      if (onTick) {
        onTick(newState);
      }

      return { x, y };
    });
  }, [mapSize, grid, paramA, paramN, paramD, paramV, paramVolt, paramEff, paramMaxI, onTick, history, stats]);

  useEffect(() => {
    let timer: any;
    if (simState === 'RUNNING') {
      timer = setInterval(() => {
        stepSimulation();
      }, animSpeed);
    }
    return () => clearInterval(timer);
  }, [simState, animSpeed, stepSimulation]);

  // Escuchar señales de control desde el dashboard
  useEffect(() => {
    const handleControl = (e: StorageEvent) => {
      if (e.key === 'simulacion_control' && e.newValue) {
        try {
          const control = JSON.parse(e.newValue);
          if (control.action === 'pause' && simState === 'RUNNING') {
            setSimState('PAUSED');
          } else if (control.action === 'resume' && simState === 'PAUSED') {
            setSimState('RUNNING');
          }
        } catch (err) {
          console.error("Error parsing control signal", err);
        }
      }
    };
    
    window.addEventListener('storage', handleControl);
    return () => window.removeEventListener('storage', handleControl);
  }, [simState]);

  const getAmperajeColor = (amp: number) => {
    if (amp < 70) return { bg: '#1a5c1a', text: '#FFF', op: 0.6 };
    if (amp <= 85) return { bg: '#367C2B', text: '#FFF', op: 0.5 };
    if (amp <= 100) return { bg: '#FFDE00', text: '#1A1A1A', op: 0.6 };
    return { bg: '#cc0000', text: '#FFF', op: 0.7 };
  };

  const totalCells = mapSize * mapSize;
  const visitedCells = Object.keys(history).length;

  return (
    <div className="flex flex-col gap-4 p-4 bg-[#F5F5F5] rounded-xl font-sans text-sm w-full max-w-6xl mx-auto shadow-lg border border-gray-200">
      
      {/* EDITOR TOOLBAR */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center p-3 bg-white rounded-lg shadow-sm border border-gray-100 gap-3">
        <div>
          <h2 className="text-lg font-bold text-[#1A1A1A]">EDITOR DE TERRENO</h2>
          <div className="flex items-center gap-4 mt-2">
            <label className="flex items-center gap-2 font-medium text-gray-600">
              Tamaño: {mapSize}x{mapSize}
              <input type="range" min="5" max="15" value={mapSize} onChange={(e) => setMapSize(parseInt(e.target.value))} disabled={simState !== 'IDLE'} className="accent-[#367C2B]" />
            </label>
            <div className="flex gap-2 border-l border-gray-300 pl-4">
              <button disabled={simState !== 'IDLE'} className="px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded font-medium disabled:opacity-50" onClick={limpiarGrid}>LIMPIAR TODO</button>
              <button disabled={simState !== 'IDLE'} className="px-3 py-1 bg-blue-100 hover:bg-blue-200 text-blue-800 rounded font-medium disabled:opacity-50" onClick={randomizeGrid}>ALEATORIO</button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {Object.values(CELL_TYPES).map(type => (
            <button key={type.id} disabled={simState !== 'IDLE'} onClick={() => setActiveBrush(type.id)}
              className={`flex flex-col items-center p-2 rounded border-2 transition-all ${activeBrush === type.id ? 'border-[#367C2B] bg-[#f0f8f0]' : 'border-transparent bg-gray-50 hover:bg-gray-100'} disabled:opacity-50`}
            >
              <span className="text-xl">{type.emoji}</span>
              <span className="text-xs font-semibold">{type.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* MAPA */}
      <div className="flex justify-center bg-white p-4 rounded-lg shadow-inner overflow-auto border border-gray-200 max-h-[60vh]">
        <div className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${mapSize}, minmax(48px, 1fr))` }} onMouseLeave={() => setIsDrawing(false)}>
          {grid.map((row, y) => 
            row.map((cellType, x) => {
              const typeData = CELL_TYPES[cellType as keyof typeof CELL_TYPES];
              const cellKey = `${x},${y}`;
              const hist = history[cellKey];
              const isTractor = tractorPos.x === x && tractorPos.y === y && simState !== 'IDLE';
              // NÚCLEO IA: ¿esta celda está siendo escaneada hacia adelante?
              const scanIdx = prediccion?.celdas?.findIndex(c => c.x === x && c.y === y) ?? -1;
              const isScan = scanIdx >= 0 && simState === 'RUNNING';
              const scanAmp = isScan ? prediccion!.amperajes[scanIdx] : 0;
              const scanPeligro = scanAmp > paramMaxI;
              
              let overlay = null;
              if (hist) {
                const colors = getAmperajeColor(hist.amperaje);
                overlay = (
                  <div className="absolute inset-0 flex items-center justify-center font-bold text-[10px] transition-all duration-200 z-10" style={{ backgroundColor: colors.bg, color: colors.text, opacity: isTractor ? 0.3 : 1 }}>
                    <div className="absolute inset-0" style={{ backgroundColor: colors.bg, opacity: colors.op }}></div>
                    <span className="relative z-10 drop-shadow-md">{hist.amperaje.toFixed(2)}A</span>
                  </div>
                );
              }

              return (
                <div 
                  key={cellKey}
                  onMouseDown={() => { setIsDrawing(true); handleCellInteract(y, x); }}
                  onMouseEnter={() => { if (isDrawing) handleCellInteract(y, x); }}
                  onMouseUp={() => setIsDrawing(false)}
                  className={`relative w-12 h-12 flex items-center justify-center rounded-sm overflow-hidden select-none cursor-pointer transition-shadow ${isTractor ? 'ring-4 ring-yellow-400 z-20 shadow-xl scale-110' : ''}`}
                  style={{ backgroundColor: typeData.color }}
                >
                  <span className="absolute top-0.5 left-0.5 text-xs opacity-80">{typeData.emoji}</span>
                  {overlay}
                  {/* NÚCLEO IA: marco de escaneo predictivo sobre celdas futuras */}
                  {isScan && !hist && (
                    <div
                      className="absolute inset-0 z-20 pointer-events-none flex items-start justify-end p-0.5"
                      style={{
                        border: `2px dashed ${scanPeligro ? '#cc0000' : '#38bdf8'}`,
                        boxShadow: `inset 0 0 8px ${scanPeligro ? 'rgba(204,0,0,0.5)' : 'rgba(56,189,248,0.4)'}`
                      }}
                    >
                      <span className="text-[8px] font-bold px-0.5 rounded" style={{ backgroundColor: scanPeligro ? '#cc0000' : '#38bdf8', color: '#fff' }}>
                        {scanAmp.toFixed(0)}
                      </span>
                    </div>
                  )}
                  {isTractor && <span className="relative z-30 text-2xl drop-shadow-md">🚜</span>}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* CONFIGURACIÓN Y CONTROLES */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* IZQ: Config Implemento */}
        <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 flex flex-col gap-3">
          <h3 className="font-bold text-[#1A1A1A] border-b pb-2">Parámetros del Implemento</h3>
          
          <label className="flex flex-col text-gray-700">
            <span className="flex justify-between">Ancho de trabajo (a): <span className="font-bold text-[#367C2B]">{paramA.toFixed(1)}m</span></span>
            <input type="range" min="0.5" max="3" step="0.1" value={paramA} onChange={e => setParamA(Number(e.target.value))} disabled={simState !== 'IDLE'} className="accent-[#367C2B]" />
          </label>
          <label className="flex flex-col text-gray-700">
            <span className="flex justify-between">Número de cuerpos (n): <span className="font-bold text-[#367C2B]">{paramN}</span></span>
            <input type="range" min="1" max="8" step="1" value={paramN} onChange={e => setParamN(Number(e.target.value))} disabled={simState !== 'IDLE'} className="accent-[#367C2B]" />
          </label>
          <label className="flex flex-col text-gray-700">
            <span className="flex justify-between">Profundidad inicial (d): <span className="font-bold text-[#367C2B]">{paramD}cm</span></span>
            <input type="range" min="10" max="40" step="1" value={paramD} onChange={e => setParamD(Number(e.target.value))} disabled={simState !== 'IDLE'} className="accent-[#367C2B]" />
          </label>
          <label className="flex flex-col text-gray-700">
            <span className="flex justify-between">Velocidad: <span className="font-bold text-[#367C2B]">{paramV} km/h</span></span>
            <input type="range" min="3" max="12" step="1" value={paramV} onChange={e => setParamV(Number(e.target.value))} disabled={simState !== 'IDLE'} className="accent-[#367C2B]" />
          </label>
        </div>

        {/* DER: Config Tractor */}
        <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 flex flex-col gap-3">
          <h3 className="font-bold text-[#1A1A1A] border-b pb-2">Parámetros del Tractor</h3>
          
          <label className="flex flex-col text-gray-700">
            <span className="flex justify-between">Voltaje del sistema: <span className="font-bold border bg-gray-100 px-2 rounded">{paramVolt}V</span></span>
            <select value={paramVolt} onChange={e => setParamVolt(Number(e.target.value))} disabled={simState !== 'IDLE'} className="p-1 border rounded mt-1 outline-none focus:border-[#367C2B]">
              <option value="400">400V</option>
              <option value="700">700V</option>
              <option value="800">800V</option>
            </select>
          </label>
          <label className="flex flex-col text-gray-700 mt-2">
            <span className="flex justify-between">Eficiencia transmisión (η): <span className="font-bold text-[#367C2B]">{Math.round(paramEff * 100)}%</span></span>
            <input type="range" min="0.70" max="0.95" step="0.01" value={paramEff} onChange={e => setParamEff(Number(e.target.value))} disabled={simState !== 'IDLE'} className="accent-[#367C2B]" />
          </label>
          <label className="flex flex-col text-gray-700">
            <span className="flex justify-between">Amperaje Máximo Permitido: <span className="font-bold text-red-600">{paramMaxI}A</span></span>
            <input type="range" min="80" max="150" step="1" value={paramMaxI} onChange={e => setParamMaxI(Number(e.target.value))} disabled={simState !== 'IDLE'} className="accent-red-600" />
          </label>

          {/* BOTONES DE CONTROL */}
          <div className="flex gap-2 mt-auto pt-4 border-t border-gray-100">
            {simState === 'IDLE' || simState === 'PAUSED' ? (
              <button className="flex-1 bg-[#367C2B] hover:bg-[#2b6322] text-white font-bold py-2 px-4 rounded shadow transition-colors flex items-center justify-center gap-2 uppercase tracking-wide text-sm"
                onClick={() => setSimState('RUNNING')}>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
                {simState === 'IDLE' ? 'Iniciar simulación' : 'Reanudar'}
              </button>
            ) : (
              <button className="flex-1 bg-[#FFDE00] hover:bg-[#e6c800] text-[#1A1A1A] font-bold py-2 px-4 rounded shadow transition-colors flex items-center justify-center gap-2 uppercase tracking-wide text-sm"
                onClick={() => setSimState('PAUSED')}>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                Pausar
              </button>
            )}
            <button className="bg-white border border-gray-300 hover:bg-gray-100 text-gray-700 font-bold py-2 px-4 rounded transition-colors flex items-center justify-center gap-2 uppercase tracking-wide text-sm"
                onClick={() => { setSimState('IDLE'); limpiarGrid(); }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
              Reset
            </button>
          </div>
        </div>
      </div>

      {/* ANIMACION Y STATS ESTADO */}
      <div className="flex flex-col md:flex-row gap-4">
        {/* Columna izquierda: control de simulación + visión IA */}
        <div className="flex-none w-full md:w-2/5 flex flex-col gap-4">
          {/* Velocidad animacion */}
          <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Velocidad de Simulación</h3>
            <div className="flex gap-2">
              {[ { k: 1000, label: 'Lento' }, { k: 333, label: 'Normal' }, { k: 100, label: 'Rápido' } ].map(s => (
                <button key={s.k} onClick={() => setAnimSpeed(s.k)}
                  className={`flex-1 py-2 rounded border font-semibold text-xs transition-colors ${animSpeed === s.k ? 'bg-[#367C2B] border-[#367C2B] text-white' : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                  {s.label}
                </button>
              ))}
            </div>

            {/* Indicador de pausa por alerta */}
            {simState === 'PAUSED' && (
              <div className="mt-3 p-3 bg-[#FFFBEB] border-l-4 border-[#FFDE00] rounded-r flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-[#FFDE00] flex items-center justify-center shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="#1A1A1A"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                </div>
                <div className="text-xs">
                  <div className="font-bold text-[#1A1A1A]">Pausado por alerta</div>
                  <div className="text-gray-500">Esperando decisión del operador</div>
                </div>
              </div>
            )}
          </div>

          {/* NÚCLEO IA: Visión predictiva del terreno */}
          <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 border-t-4 border-t-[#367C2B]">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Visión Predictiva</h3>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide">Núcleo IA · Escaneo del terreno</p>
              </div>
              <span className="text-[10px] font-bold text-gray-400 bg-gray-100 px-2 py-1 rounded">+{LOOKAHEAD} celdas</span>
            </div>
            {prediccion && prediccion.amperajes.length > 0 ? (
              <>
                {/* Mini-barras de amperaje previsto en próximas celdas */}
                <div className="flex items-end gap-2 h-20 mb-3">
                  {prediccion.amperajes.map((amp, i) => {
                    const peligro = amp > paramMaxI;
                    const h = Math.min(100, (amp / (paramMaxI * 1.3)) * 100);
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center justify-end h-full">
                        <span className="text-[10px] font-bold mb-1" style={{ color: peligro ? '#cc0000' : '#367C2B' }}>{amp.toFixed(0)}A</span>
                        <div className="w-full rounded-t transition-all duration-300" style={{ height: `${h}%`, backgroundColor: peligro ? '#cc0000' : '#367C2B' }}></div>
                        <span className="text-[9px] text-gray-400 mt-1">+{i + 1}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="border-t border-gray-100 pt-3">
                  {prediccion.picoPrevisto > paramMaxI ? (
                    <p className="text-xs text-gray-600 leading-snug">
                      <span className="font-bold text-[#cc0000]">Pico previsto {prediccion.picoPrevisto.toFixed(0)}A.</span> Pre-ajustando profundidad a <span className="font-bold text-[#1A1A1A]">{prediccion.dObjetivo.toFixed(0)}cm</span> antes de llegar.
                    </p>
                  ) : (
                    <p className="text-xs text-[#367C2B] font-medium leading-snug">
                      Terreno despejado adelante. Operando a profundidad recomendada.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-gray-400 py-4 text-center">Inicia la simulación para activar el escaneo predictivo del terreno.</p>
            )}
          </div>
        </div>

        {/* Live stats: tarjetas claras */}
        <div className="grow bg-white p-4 rounded-lg shadow-sm border border-gray-100">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Telemetría en Vivo</h3>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {/* Amperaje */}
            <div className="bg-[#F5F5F5] rounded-md p-3">
              <span className="text-[10px] uppercase tracking-wide text-gray-500 font-bold block mb-1">Amperaje actual</span>
              <span className={`text-2xl font-bold ${stats.amperajeActual > paramMaxI ? 'text-[#cc0000]' : 'text-[#1A1A1A]'}`}>
                {stats.amperajeActual.toFixed(1)}<span className="text-sm font-semibold text-gray-400 ml-1">A</span>
              </span>
            </div>
            {/* Profundidad */}
            <div className="bg-[#F5F5F5] rounded-md p-3">
              <span className="text-[10px] uppercase tracking-wide text-gray-500 font-bold block mb-1">Profundidad</span>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-[#1A1A1A]">{stats.profundidadActual}<span className="text-sm font-semibold text-gray-400 ml-1">cm</span></span>
                {stats.profundidadActual < stats.recomendada && <span className="text-[9px] font-bold text-[#367C2B] uppercase">Ajustada</span>}
              </div>
            </div>
            {/* Avance */}
            <div className="bg-[#F5F5F5] rounded-md p-3">
              <span className="text-[10px] uppercase tracking-wide text-gray-500 font-bold block mb-1">Avance</span>
              <span className="text-2xl font-bold text-[#1A1A1A]">{Math.round((visitedCells / totalCells) * 100)}<span className="text-sm font-semibold text-gray-400 ml-0.5">%</span></span>
              <span className="text-[10px] text-gray-400 ml-1">({visitedCells}/{totalCells})</span>
            </div>
            {/* Overloads */}
            <div className="bg-[#F5F5F5] rounded-md p-3">
              <span className="text-[10px] uppercase tracking-wide text-gray-500 font-bold block mb-1">Overloads</span>
              <span className="text-2xl font-bold text-[#cc0000]">{stats.ajustes}</span>
              <span className="text-[10px] text-gray-400 ml-1">reactivos</span>
            </div>
            {/* Pre-ajustes IA */}
            <div className="bg-[#F5F5F5] rounded-md p-3">
              <span className="text-[10px] uppercase tracking-wide text-gray-500 font-bold block mb-1">Pre-ajustes IA</span>
              <span className="text-2xl font-bold text-[#367C2B]">{stats.preajustes}</span>
              <span className="text-[10px] text-gray-400 ml-1">anticipados</span>
            </div>
            {/* Energía */}
            <div className="bg-[#F5F5F5] rounded-md p-3">
              <span className="text-[10px] uppercase tracking-wide text-gray-500 font-bold block mb-1">Energía usada</span>
              <span className="text-2xl font-bold text-[#1A1A1A]">{stats.kwhAcumulados.toFixed(2)}<span className="text-sm font-semibold text-gray-400 ml-1">kWh</span></span>
            </div>
          </div>

          {/* Batería restante: barra ancha */}
          <div className="mt-3 bg-[#F5F5F5] rounded-md p-3">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[10px] uppercase tracking-wide text-gray-500 font-bold">Batería restante</span>
              <span className={`text-lg font-bold ${stats.bateria < 10 ? 'text-[#cc0000]' : stats.bateria < 20 ? 'text-[#b58900]' : 'text-[#367C2B]'}`}>
                {stats.bateria.toFixed(1)} <span className="text-xs font-semibold text-gray-400">/ 50 kWh</span>
              </span>
            </div>
            <div className="w-full h-2.5 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${stats.bateria < 10 ? 'bg-[#cc0000]' : stats.bateria < 20 ? 'bg-[#FFDE00]' : 'bg-[#367C2B]'}`}
                style={{ width: `${(stats.bateria / 50) * 100}%` }}
              ></div>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
