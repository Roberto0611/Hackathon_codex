import { useState, useEffect, useRef, useCallback } from 'react';

const CELL_TYPES = {
  NORMAL: { id: 'NORMAL', color: '#8B5E3C', emoji: '🟫', k: 30, name: 'Normal' },
  LODO: { id: 'LODO', color: '#4a3728', emoji: '💧', k: 80, name: 'Lodo' },
  PIEDRA: { id: 'PIEDRA', color: '#6b6b6b', emoji: '🪨', k: 110, name: 'Piedra' },
  HIERBA: { id: 'HIERBA', color: '#7db356', emoji: '🌿', k: 20, name: 'Hierba' },
  SECO: { id: 'SECO', color: '#c4a882', emoji: '☀️', k: 15, name: 'Seco' },
  INUNDADO: { id: 'INUNDADO', color: '#2c5f8a', emoji: '🌊', k: 120, name: 'Inundado' }
};

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

  // Inicializar grid
  useEffect(() => {
    if (simState === 'IDLE') {
      const newGrid = Array(mapSize).fill(0).map(() => Array(mapSize).fill('NORMAL'));
      setGrid(newGrid);
      setHistory({});
      setTractorPos({ x: 0, y: 0 });
      setStats({
        ajustes: 0,
        kwhAcumulados: 0,
        amperajeActual: 0,
        profundidadActual: paramD,
        recomendada: paramD,
        kwhAhorrados: 0,
        bateria: 50 // Reducido de 150 a 50 kWh para consumo más visible
      });
      historyAmpArr.current = [];
    }
  }, [mapSize, simState]);

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
      
      let d_current = stats.profundidadActual;
      let amperaje = 0;
      let requiredAdjustments = 0;

      // Cálculo de fórmulas y peak shaving
      let iterSafety = 10;
        while (iterSafety > 0) {
          const R_kN = k * paramA * (d_current / 100) * paramN;
          const R_N = R_kN * 1000;
          const v_ms = paramV / 3.6;
          const P_watts = (R_N * v_ms) / paramEff;
          amperaje = P_watts / paramVolt;

          if (amperaje > paramMaxI && d_current > 10) {
            d_current -= 2;
            requiredAdjustments++;
          } else {
            break;
          }
          iterSafety--;
        }

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
        kwhAcumulados: prevStats.kwhAcumulados + kWhThisCell,
        amperajeActual: amperaje,
        profundidadActual: d_current,
        recomendada: paramD,
        kwhAhorrados: prevStats.kwhAhorrados + (requiredAdjustments * 0.15),
        bateria: Math.max(0, prevStats.bateria - kWhThisCell) // Usar kWhThisCell que ya incluye el factor 8x
      }));

      const newAj = stats.ajustes + requiredAdjustments;
      const newAhorros = stats.kwhAhorrados + (requiredAdjustments * 0.15);
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
        mapa_terreno: grid,
        tractor_pos: { x, y },
        historial_mapa: { ...history, [cellKey]: { amperaje, profundidad_usada: d_current } }
      };

      try {
        localStorage.setItem('tractor_telemetry', JSON.stringify(newState));
      } catch (e) {
        console.error("Error writing to localStorage", e);
      }

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
              <button className="flex-1 bg-[#367C2B] hover:bg-[#2b6322] text-white font-bold py-2 px-4 rounded shadow transition-colors" 
                onClick={() => setSimState('RUNNING')}>
                ▶ {simState === 'IDLE' ? 'INICIAR SIMULACIÓN' : 'REANUDAR'}
              </button>
            ) : (
              <button className="flex-1 bg-[#FFDE00] hover:bg-[#e6c800] text-[#1A1A1A] font-bold py-2 px-4 rounded shadow transition-colors" 
                onClick={() => setSimState('PAUSED')}>
                ⏸ PAUSAR
              </button>
            )}
            <button className="bg-gray-400 hover:bg-gray-500 text-white font-bold py-2 px-4 rounded shadow transition-colors"
                onClick={() => { setSimState('IDLE'); limpiarGrid(); }}>
              ⏹ RESET
            </button>
          </div>
        </div>
      </div>

      {/* ANIMACION Y STATS ESTADO */}
      <div className="flex flex-col md:flex-row gap-4">
        {/* Velocidad animacion */}
        <div className="flex-none bg-white p-4 rounded-lg shadow-sm border border-gray-100 w-full md:w-1/3">
          <h3 className="font-bold text-[#1A1A1A] mb-3">Velocidad de Simulación</h3>
          <div className="flex gap-2">
            {[ { k: 1000, label: 'Lento' }, { k: 333, label: 'Normal' }, { k: 100, label: 'Rápido' } ].map(s => (
              <button key={s.k} onClick={() => setAnimSpeed(s.k)}
                className={`flex-1 py-1 rounded border font-semibold text-xs ${animSpeed === s.k ? 'bg-blue-100 border-blue-400 text-blue-800' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'}`}>
                {s.label}
              </button>
            ))}
          </div>
          
          {/* Indicador de pausa por alerta */}
          {simState === 'PAUSED' && (
            <div className="mt-3 p-2 bg-yellow-50 border-l-4 border-[#FFDE00] rounded">
              <div className="flex items-center gap-2">
                <span className="text-xl">⏸</span>
                <div className="text-xs">
                  <div className="font-bold text-[#1A1A1A]">Pausado por Alerta</div>
                  <div className="text-gray-600">Esperando decisión del operador...</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Live stats */}
        <div className="grow bg-[#1A1A1A] p-4 rounded-lg shadow-sm text-gray-300 font-mono text-xs flex flex-wrap gap-4">
          <div className="w-1/3 min-w-[120px]">
            <span className="text-gray-500 block mb-1">AMPERAJE ACTUAL</span>
            <span className={`text-2xl font-bold ${stats.amperajeActual > paramMaxI ? 'text-red-500' : 'text-[#FFDE00]'}`}>
              {stats.amperajeActual.toFixed(2)} A
            </span>
          </div>
          <div className="w-1/3 min-w-[120px]">
            <span className="text-gray-500 block mb-1">PROFUNDIDAD (d)</span>
            <span className="text-2xl font-bold text-white">
              {stats.profundidadActual} <span className="text-sm font-normal">cm</span>
            </span>
            {stats.profundidadActual < stats.recomendada && <span className="ml-2 text-yellow-400 text-[10px]">Peak Shaved</span>}
          </div>
          <div className="w-1/3 min-w-[120px]">
            <span className="text-gray-500 block mb-1">AVANCE</span>
            <span className="text-2xl font-bold text-white">
              {Math.round((visitedCells / totalCells) * 100)}%
            </span>
            <span className="ml-2">({visitedCells}/{totalCells})</span>
          </div>
          <div className="w-1/3 min-w-[120px]">
            <span className="text-gray-500 block mb-1">OVERLOADS REGISTRADOS</span>
            <span className="text-xl font-bold text-red-400">{stats.ajustes} eventos</span>
          </div>
          <div className="w-1/3 min-w-[120px]">
            <span className="text-gray-500 block mb-1">ENERGÍA (ESTIMADA)</span>
            <span className="text-xl font-bold text-[#7db356]">{stats.kwhAcumulados.toFixed(2)} kWh</span>
          </div>
          <div className="w-1/3 min-w-[120px]">
            <span className="text-gray-500 block mb-1">BATERÍA RESTANTE</span>
            <span className={`text-xl font-bold ${stats.bateria < 10 ? 'text-red-500 animate-pulse' : stats.bateria < 20 ? 'text-yellow-400' : 'text-[#367C2B]'}`}>
              {stats.bateria.toFixed(2)} kWh
            </span>
            <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden mt-1">
              <div 
                className={`h-full transition-all duration-300 ${stats.bateria < 10 ? 'bg-red-500' : stats.bateria < 20 ? 'bg-yellow-400' : 'bg-[#367C2B]'}`}
                style={{ width: `${(stats.bateria / 50) * 100}%` }}
              ></div>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
