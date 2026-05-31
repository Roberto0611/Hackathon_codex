import { useState, useEffect, useRef } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea
} from 'recharts';

// --- Constantes de Diseño (Identidad John Deere) ---
const COLORS = {
  green: '#367C2B',
  yellow: '#FFDE00',
  dark: '#1A1A1A',
  gray: '#F5F5F5',
  white: '#FFFFFF',
  mapLow: '#A5D6A7', // Verde claro
  mapMed: '#FFF59D', // Amarillo suave
  mapHigh: '#EF9A9A' // Rojo suave
};

// --- Núcleo IA: Sistema de prioridades de energía ---
// Potencia que el bus/batería puede entregar de forma sostenida (kW).
const POTENCIA_BUS = 78;

// Jerarquía de subsistemas. La IA nunca reduce prioridad 1.
// base: demanda nominal (kW) en condiciones normales.
// sensibilidadCarga: cuánto crece su demanda cuando el terreno exige más (0 = constante).
// minRatio: piso mínimo respecto a su nominal antes de comprometer la operación.
const SUBSISTEMAS = [
  { id: 'sensores',   nombre: 'Sensores y Control', prioridad: 1, base: 6,  sensibilidadCarga: 0,   minRatio: 1.0 },
  { id: 'traccion',   nombre: 'Tracción',           prioridad: 2, base: 22, sensibilidadCarga: 0.9, minRatio: 0.85 },
  { id: 'elevador',   nombre: 'Motor Elevador',     prioridad: 2, base: 26, sensibilidadCarga: 1.0, minRatio: 0.6 },
  { id: 'hidraulica', nombre: 'Hidráulica Auxiliar', prioridad: 3, base: 12, sensibilidadCarga: 0,   minRatio: 0.3 },
  { id: 'cabina',     nombre: 'Confort de Cabina',  prioridad: 3, base: 8,  sensibilidadCarga: 0,   minRatio: 0.15 }
];

// Reasigna los kW disponibles respetando la jerarquía de prioridades.
// Recorta primero los auxiliares (P3) y solo en caso extremo toca P2. Nunca P1.
// loadFactor <= 0 representa tractor inactivo: sin demanda.
function redistribuirEnergia(loadFactor: number, disponible: number) {
  // Tractor inactivo: ningún subsistema consume.
  if (loadFactor <= 0) {
    const items = SUBSISTEMAS.map(s => ({
      id: s.id,
      nombre: s.nombre,
      prioridad: s.prioridad,
      demandado: 0,
      asignado: 0,
      piso: 0
    }));
    return { items, totalDemandado: 0, totalAsignado: 0, disponible, reducciones: [] as { id: string; nombre: string; pct: number }[] };
  }

  const lf = Math.max(1, loadFactor);

  const items = SUBSISTEMAS.map(s => {
    const demandado = s.base * (1 + s.sensibilidadCarga * (lf - 1));
    return {
      id: s.id,
      nombre: s.nombre,
      prioridad: s.prioridad,
      demandado,
      asignado: demandado,
      piso: s.base * s.minRatio
    };
  });

  const totalDemandado = items.reduce((acc, it) => acc + it.demandado, 0);
  let deficit = totalDemandado - disponible;

  if (deficit > 0.01) {
    // Recortar por nivel: primero auxiliares (3), luego esenciales secundarios (2).
    for (const nivel of [3, 2]) {
      if (deficit <= 0.01) break;
      const grupo = items.filter(it => it.prioridad === nivel);
      const margenGrupo = grupo.reduce((acc, it) => acc + (it.asignado - it.piso), 0);
      if (margenGrupo <= 0) continue;

      const recorteGrupo = Math.min(deficit, margenGrupo);
      for (const it of grupo) {
        const margenItem = it.asignado - it.piso;
        if (margenItem <= 0) continue;
        it.asignado -= recorteGrupo * (margenItem / margenGrupo);
      }
      deficit -= recorteGrupo;
    }
  }

  const reducciones = items
    .map(it => ({
      id: it.id,
      nombre: it.nombre,
      pct: it.demandado > 0 ? Math.round((1 - it.asignado / it.demandado) * 100) : 0
    }))
    .filter(r => r.pct >= 1);

  const totalAsignado = items.reduce((acc, it) => acc + it.asignado, 0);

  return { items, totalDemandado, totalAsignado, disponible, reducciones };
}

// --- Estado Inicial (sin datos hasta iniciar simulación) ---
const INITIAL_STATE = {
  posicion: { x: 0, y: 0 },
  amperaje: { actual: 0, optimo: 75, maximo: 120 },
  profundidad: { actual: 0, recomendada: 0 },
  velocidad: 0,
  rpm: 0,
  bateria: { porcentaje: 0, horas_restantes: 0 },
  kw_subsistemas: {
    implemento: 0,
    traccion: 0,
    hidraulica: 0,
    cabina: 0
  },
  estado: "inactivo",
  ajustes_automaticos: 0,
  kwh_ahorrados: 0,
  historial_amperaje: [] as number[],
  alerta: {
    activa: false,
    tipo: "peak_shaving",
    mensaje: "",
    countdown: 7,
    max_countdown: 7
  },
  mapa_terreno: [
    [1, 1, 2, 2, 3],
    [1, 2, 2, 3, 3],
    [2, 2, 3, 3, 2],
    [1, 1, 2, 2, 1]
  ],
  tractor_pos: { x: -1, y: -1 }, // fuera del mapa hasta que arranque la simulación
  logs_recientes: [] as string[]
};

// --- Perfil del operador reconocido al encender el tractor ---
const PERFIL_OPERADOR = {
  nombre: "Juan",
  lote: "Lote 4",
  cultivo: "Trigo",
  profundidadRecomendada: 24, // cm
  unidad: "EV-7820"
};

export default function App() {
  const [data, setData] = useState(INITIAL_STATE);
  const [sesionIniciada, setSesionIniciada] = useState(false);
  const [historial, setHistorial] = useState<Record<string, number>>({});
  const [parcelasCompletadas, setParcelasCompletadas] = useState<Array<{
    fecha: string;
    amperajePromedio: number;
    amperajeTotal: number;
    celdasRecorridas: number;
    kwhTotal: number;
  }>>([]);
  const [mostrarReporte, setMostrarReporte] = useState(false);
  const [reporteActual, setReporteActual] = useState<any>(null);
  
  // --- Simulación de WebSocket (Tiempo Real) ---
  useEffect(() => { 
    const h=(e: StorageEvent)=>{
      if(e.key==='tractor_telemetry'&&e.newValue){
        try{
          const t=JSON.parse(e.newValue);
          
          // Detectar si la parcela se completó
          if(t.parcelaCompletada && t.estadisticasParcela) {
            const nuevaParcela = {
              fecha: new Date().toLocaleString('es-ES', { 
                day: '2-digit', 
                month: '2-digit', 
                year: 'numeric',
                hour: '2-digit', 
                minute: '2-digit' 
              }),
              amperajePromedio: parseFloat(t.estadisticasParcela.amperajePromedio.toFixed(2)),
              amperajeTotal: parseFloat(t.estadisticasParcela.amperajeTotal.toFixed(2)),
              celdasRecorridas: t.estadisticasParcela.celdasRecorridas,
              kwhTotal: parseFloat(t.estadisticasParcela.kwhTotal.toFixed(2))
            };
            setParcelasCompletadas(prev => [nuevaParcela, ...prev]);
            
            // Generar reporte de eficiencia
            generarReporteEficiencia(t, nuevaParcela);
          }
          
          setData(p=>{
            const pa=t.amperaje.actual>t.amperaje.maximo;
            let cl=p.logs_recientes;
            let ca=p.alerta;
            if(pa&&!p.alerta.activa){
              ca={activa:true,tipo:'peak_shaving',mensaje:'Pico de consumo. Ajustando...',countdown:3,max_countdown:3};
              cl=['Pico de Amperaje',...cl.slice(0,3)];
              
              // Pausar simulación cuando aparece alerta
              try {
                localStorage.setItem('simulacion_control', JSON.stringify({ action: 'pause' }));
              } catch (e) {
                console.error("Error writing to localStorage", e);
              }
            }else if(!pa&&p.alerta.activa){
              ca={...p.alerta,activa:false};
            }
            return{...p,...t,alerta:ca,logs_recientes:cl};
          });
          
          if(t.historial_mapa){
            const ch: Record<string, number> = {};
            for(const[k,v] of Object.entries(t.historial_mapa)){
              ch[k]=(v as any).amperaje;
            }
            setHistorial(ch);
          }
        }catch(err){}
      }
    };
    window.addEventListener('storage',h);
    return()=>window.removeEventListener('storage',h); 
  }, []);

  // Función para generar reporte de eficiencia
  const generarReporteEficiencia = (telemetria: any, parcela: any) => {
    // --- Parámetros económicos (contexto agrícola, MXN) ---
    const COSTO_ENERGIA_KWH = 3.5;        // Tarifa industrial promedio MXN/kWh
    const COSTO_TIEMPO_MINUTO = 42;       // Costo de operación detenida: operador + máquina + cosecha no realizada (MXN/min)
    const COSTO_ZONA_DEFICIENTE = 580;    // Pérdida de rendimiento por zona mal trabajada (MXN/zona)

    const ajustesRealizados = telemetria.ajustes_automaticos || 0;
    const kwhAhorrados = telemetria.kwh_ahorrados || 0;

    // Escenario SIN sistema: las sobrecargas obligan a detener y reajustar manualmente
    const minutosParados = ajustesRealizados * 3;             // ~3 min de paro por sobrecarga
    const zonasDeficientes = Math.floor(ajustesRealizados / 2); // Trabajo deficiente sin corrección a tiempo

    // --- Desglose de costos evitados ---
    const costoEnergia = kwhAhorrados * COSTO_ENERGIA_KWH;        // Energía desperdiciada
    const costoTiempo = minutosParados * COSTO_TIEMPO_MINUTO;     // Tiempo improductivo = menos cosecha
    const costoZonas = zonasDeficientes * COSTO_ZONA_DEFICIENTE;  // Rendimiento perdido
    const costoTotalEvitado = costoEnergia + costoTiempo + costoZonas;

    // Tiempo total de la jornada (estimado por celdas recorridas)
    const tiempoJornadaMinutos = parcela.celdasRecorridas * 0.5;

    // Eficiencia de batería
    const bateriaRestantePorcentaje = telemetria.bateria?.porcentaje || 0;
    const horasRestantes = telemetria.bateria?.horas_restantes || 0;

    const reporte = {
      fecha: parcela.fecha,
      conSistema: {
        minutosParados: 0,
        zonasDeficientes: 0,
        ajustesAutomaticos: ajustesRealizados,
        kwhConsumidos: parcela.kwhTotal,
        costoEnergia: parcela.kwhTotal * COSTO_ENERGIA_KWH,
        bateriaRestante: bateriaRestantePorcentaje,
        horasRestantes: horasRestantes
      },
      sinSistema: {
        minutosParados: minutosParados,
        zonasDeficientes: zonasDeficientes,
        kwhConsumidos: parcela.kwhTotal + kwhAhorrados,
        bateriaRestante: Math.max(0, bateriaRestantePorcentaje - 15)
      },
      // Costos evitados gracias al sistema (desglosados)
      costos: {
        energia: costoEnergia,
        tiempo: costoTiempo,
        zonas: costoZonas,
        total: costoTotalEvitado
      },
      impacto: {
        minutos: minutosParados,
        zonas: zonasDeficientes,
        kwh: kwhAhorrados
      },
      parcela: {
        celdasRecorridas: parcela.celdasRecorridas,
        tiempoTotal: tiempoJornadaMinutos,
        amperajePromedio: parcela.amperajePromedio
      }
    };

    setReporteActual(reporte);
    setMostrarReporte(true);
  };

  const handleAceptarAjuste = () => {
    setData(prev => ({
      ...prev,
      alerta: { ...prev.alerta, activa: false },
      ajustes_automaticos: prev.ajustes_automaticos + 1,
      kwh_ahorrados: +(prev.kwh_ahorrados + 0.2).toFixed(1),
      profundidad: { ...prev.profundidad, actual: prev.profundidad.recomendada },
      logs_recientes: [ `Manual: Confirmó ajuste recomendado`, ...prev.logs_recientes.slice(0, 4) ]
    }));
    
    // Reanudar simulación
    try {
      localStorage.setItem('simulacion_control', JSON.stringify({ action: 'resume' }));
    } catch (e) {
      console.error("Error writing to localStorage", e);
    }
  };

  const handleRechazarAjuste = () => {
    setData(prev => ({
      ...prev,
      alerta: { ...prev.alerta, activa: false },
      logs_recientes: [ `Manual: Operador asume control puenteando sugerencia`, ...prev.logs_recientes.slice(0, 4) ]
    }));
    
    // Reanudar simulación
    try {
      localStorage.setItem('simulacion_control', JSON.stringify({ action: 'resume' }));
    } catch (e) {
      console.error("Error writing to localStorage", e);
    }
  };

  // Preparar datos para las gráficas
  const chartData = data.historial_amperaje.map((val, idx) => ({ time: idx, Amp: val }));

  // --- Núcleo IA: redistribución de energía en tiempo real ---
  // El factor de carga se deriva de qué tan por encima del óptimo está el amperaje.
  const loadFactor = data.amperaje.optimo > 0 ? data.amperaje.actual / data.amperaje.optimo : 1;
  const energia = redistribuirEnergia(loadFactor, POTENCIA_BUS);
  const redistribucionActiva = energia.reducciones.length > 0;
  const operacionInactiva = energia.totalDemandado <= 0;

  // Registrar en el log cuando la IA entra o sale de redistribución
  const prevRedistRef = useRef(false);
  useEffect(() => {
    if (redistribucionActiva === prevRedistRef.current) return;
    prevRedistRef.current = redistribucionActiva;

    // No registrar nada mientras el tractor está inactivo
    if (operacionInactiva) return;

    const mensaje = redistribucionActiva
      ? `IA: Redistribución activa — ${energia.reducciones.map(r => `${r.nombre} -${r.pct}%`).join(', ')}`
      : 'IA: Energía restablecida a plena potencia';

    setData(prev => ({
      ...prev,
      logs_recientes: [mensaje, ...prev.logs_recientes.slice(0, 4)]
    }));
  }, [redistribucionActiva]);

  // Confirmar set point recomendado y arrancar la jornada
  const handleComenzarJornada = () => {
    const hora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    setData(prev => ({
      ...prev,
      profundidad: { ...prev.profundidad, actual: PERFIL_OPERADOR.profundidadRecomendada, recomendada: PERFIL_OPERADOR.profundidadRecomendada },
      logs_recientes: [
        `${hora} Sesión iniciada: ${PERFIL_OPERADOR.nombre} · ${PERFIL_OPERADOR.lote}`,
        ...prev.logs_recientes.slice(0, 4)
      ]
    }));
    setSesionIniciada(true);
  };

  // --- Pantalla de bienvenida / perfil del operador ---
  if (!sesionIniciada) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] text-white font-sans flex flex-col items-center justify-center p-6 relative overflow-hidden">
        {/* Franja superior corporativa */}
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-[#FFDE00]"></div>

        <div className="w-full max-w-lg">
          {/* Marca */}
          <div className="flex items-center gap-3 mb-10">
            <img
              src="logo.png"
              alt="John Deere"
              className="h-9 bg-white p-1 rounded-sm object-contain"
              onError={(e) => { const t = e.target as HTMLImageElement; t.style.display = 'none'; if (t.nextSibling) (t.nextSibling as HTMLElement).style.display = 'block'; }}
            />
            <span style={{ display: 'none' }} className="font-bold text-xl tracking-widest text-[#FFDE00]">JOHN DEERE</span>
            <div className="w-px h-6 bg-white/20"></div>
            <span className="text-sm font-bold uppercase tracking-wider text-white/70">EV Peak Shaver</span>
          </div>

          {/* Estado del sistema */}
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 rounded-full bg-[#7db356] animate-pulse"></span>
            <span className="text-xs uppercase tracking-wide text-white/50">Operador reconocido · Unidad {PERFIL_OPERADOR.unidad}</span>
          </div>

          {/* Bienvenida */}
          <h1 className="text-5xl font-bold tracking-tight mb-2">
            Hola, {PERFIL_OPERADOR.nombre}.
          </h1>
          <p className="text-white/60 text-lg mb-8">Tu jornada está lista para comenzar.</p>

          {/* Ficha del día */}
          <div className="bg-white/5 border border-white/10 rounded-lg divide-y divide-white/10 mb-8">
            <div className="flex justify-between items-center px-5 py-4">
              <span className="text-sm text-white/50 uppercase tracking-wide">Lote del día</span>
              <span className="text-lg font-bold">{PERFIL_OPERADOR.lote}</span>
            </div>
            <div className="flex justify-between items-center px-5 py-4">
              <span className="text-sm text-white/50 uppercase tracking-wide">Cultivo</span>
              <span className="text-lg font-bold">{PERFIL_OPERADOR.cultivo}</span>
            </div>
            <div className="flex justify-between items-center px-5 py-4">
              <span className="text-sm text-white/50 uppercase tracking-wide">Profundidad recomendada</span>
              <span className="text-lg font-bold text-[#FFDE00]">{PERFIL_OPERADOR.profundidadRecomendada} cm</span>
            </div>
          </div>

          {/* Acción única */}
          <button
            onClick={handleComenzarJornada}
            className="w-full bg-[#367C2B] hover:bg-[#2b6322] text-white font-bold text-lg py-5 uppercase tracking-wider transition-colors flex items-center justify-center gap-3"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>
            Comenzar
          </button>
          <p className="text-center text-white/40 text-xs mt-4">
            Set point recomendado por IA según operador, lote y cultivo. Podrás ajustarlo en cualquier momento.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F5F5F5] text-[#1A1A1A] font-sans relative overflow-hidden flex flex-col">
      
      {/* HEADER */}
      <header className="bg-[#367C2B] text-white px-6 py-4 flex justify-between items-center shadow-md z-10">
        <div className="flex items-center gap-4">
          {/* Logo simulado por IMG como requerido */}
          <img src="logo.png" alt="John Deere Logo" className="h-8 bg-white p-1 rounded-sm object-contain" onError={(e) => { const target = e.target as HTMLImageElement; target.style.display='none'; if(target.nextSibling) (target.nextSibling as HTMLElement).style.display='block'; }} />
          <div style={{display:'none'}} className="font-bold text-2xl tracking-widest text-[#FFDE00]">JOHN DEERE</div>
          <div className="w-px h-6 bg-white/30 mx-2"></div>
          <h1 className="text-xl font-bold uppercase tracking-wider">EV Peak Shaver</h1>
          <span className="ml-4 px-3 py-1 bg-white text-[#367C2B] rounded-full text-xs font-bold uppercase">Online</span>
        </div>
        <div className="flex gap-6 text-sm font-bold items-center">
          <div className="flex flex-col items-end pr-2 border-r border-white/20">
            <span className="text-white/60 uppercase text-[10px]">Operador</span>
            <span className="text-sm leading-none">{PERFIL_OPERADOR.nombre} · {PERFIL_OPERADOR.lote}</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-white/80 uppercase text-[10px]">kWh Ahorrados</span>
            <span className="text-2xl text-[#FFDE00] leading-none">{data.kwh_ahorrados.toFixed(2)}</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-white/80 uppercase text-[10px]">Ajustes Auto</span>
            <span className="text-2xl leading-none">{data.ajustes_automaticos}</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-white/80 uppercase text-[10px]">Batería Rest.</span>
            <span className="text-2xl leading-none">{data.bateria.horas_restantes.toFixed(2)}h</span>
          </div>
        </div>
      </header>

      {/* DASHBOARD GRID */}
      <main className="flex-1 grid grid-cols-1 md:grid-cols-4 gap-4 p-4 min-h-0">
        
        {/* PANEL IZQUIERDO: Sensores en vivo */}
        <section className="bg-white p-4 shadow-sm border-t-4 border-[#367C2B] flex flex-col gap-6">
          <h2 className="text-sm font-bold uppercase text-gray-500 mb-2 tracking-wider">Parámetros Vivo</h2>
          
          {/* Gauge Amperaje Simulado con CSS/SVG */}
          <div className="flex flex-col items-center">
            <div className="relative w-40 h-20 overflow-hidden">
               {/* Arco base */}
               <div className="absolute top-0 left-0 w-40 h-40 rounded-full border-[1.5rem] border-gray-200 border-b-transparent border-r-transparent transform -rotate-45"></div>
               {/* Valor arco */}
               <div 
                 className="absolute top-0 left-0 w-40 h-40 rounded-full border-[1.5rem] border-[#FFDE00] border-b-transparent border-r-transparent transition-transform duration-500"
                 style={{ transform: `rotate(${(data.amperaje.actual / data.amperaje.maximo) * 180 - 135}deg)`, borderColor: data.amperaje.actual > data.amperaje.optimo + 10 ? '#EF9A9A' : (data.amperaje.actual > data.amperaje.optimo ? '#FFDE00' : '#367C2B') }}
               ></div>
               <div className="absolute bottom-0 text-center w-full">
                 <span className="text-3xl font-bold">{data.amperaje.actual.toFixed(2)}</span>
                 <span className="text-xs uppercase text-gray-500 ml-1">AMP</span>
               </div>
            </div>
            <div className="text-xs text-gray-500 mt-2 font-bold mb-4">Óptimo: {data.amperaje.optimo.toFixed(2)}A</div>
          </div>

          <div className="flex justify-between items-end bg-[#F5F5F5] p-4 rounded-md">
            <div>
              <div className="text-xs uppercase text-gray-500 font-bold mb-1">Profundidad</div>
              <div className="text-2xl font-bold">{data.profundidad.actual}<span className="text-sm ml-1 text-gray-500">cm</span></div>
              {data.profundidad.actual !== data.profundidad.recomendada && (
                <div className="text-xs text-[#367C2B] font-bold mt-1">Rec: {data.profundidad.recomendada}cm</div>
              )}
            </div>
            {/* Barra vertical de profundidad */}
            <div className="h-16 w-4 bg-gray-200 rounded-full overflow-hidden flex flex-col justify-end">
              <div className="w-full bg-[#367C2B] transition-all duration-300" style={{ height: `${(data.profundidad.actual / 40) * 100}%` }}></div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="bg-[#F5F5F5] p-3 rounded-md">
              <div className="text-[10px] uppercase text-gray-500 font-bold">Velocidad</div>
              <div className="text-lg font-bold">{data.velocidad.toFixed(2)} <span className="text-xs text-gray-500">km/h</span></div>
            </div>
            <div className="bg-[#F5F5F5] p-3 rounded-md border-l-4 border-[#367C2B]">
              <div className="text-[10px] uppercase text-gray-500 font-bold">Motor</div>
              <div className="text-lg font-bold">{data.rpm} <span className="text-xs text-gray-500">rpm</span></div>
            </div>
          </div>

          <div className="mt-auto">
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs uppercase text-gray-500 font-bold">Batería HV</span>
              <span className="text-sm font-bold">{data.bateria.porcentaje}%</span>
            </div>
            <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full bg-[#367C2B]" style={{ width: `${data.bateria.porcentaje}%` }}></div>
            </div>
          </div>
        </section>

        {/* PANEL CENTRAL: Mapa y Gráficas (OCUPA 2 COLUMNAS) */}
        <section className="md:col-span-2 flex flex-col gap-4">
          
          {/* SIMULADOR DE TERRENO */}
          <div className="bg-white p-4 shadow-sm flex-1 flex flex-col">
            <h2 className="text-sm font-bold uppercase text-gray-500 mb-3 tracking-wider flex justify-between">
              <span>Mapa de Resistencia (k)</span>
              <div className="flex flex-col gap-1 items-end">
                <span className="flex gap-2">
                  <span className="flex items-center text-[10px]"><span className="w-2 h-2 bg-[#A5D6A7] mr-1"></span> Baja</span>
                  <span className="flex items-center text-[10px]"><span className="w-2 h-2 bg-[#FFF59D] mr-1"></span> Media</span>
                  <span className="flex items-center text-[10px]"><span className="w-2 h-2 bg-[#EF9A9A] mr-1"></span> Alta</span>
                </span>
                <span className="flex gap-2 text-[9px] text-gray-400 font-bold mt-1">
                  <span className="mr-1 relative -top-px">RECORRIDO:</span>
                  <span className="flex items-center"><span className="w-2 h-2 mr-1" style={{backgroundColor: '#1a5c1a', opacity: 0.6}}></span> &lt;70A</span>
                  <span className="flex items-center"><span className="w-2 h-2 mr-1" style={{backgroundColor: '#367C2B', opacity: 0.5}}></span> 70-85A</span>
                  <span className="flex items-center"><span className="w-2 h-2 mr-1" style={{backgroundColor: '#FFDE00', opacity: 0.6}}></span> 85-100A</span>
                  <span className="flex items-center"><span className="w-2 h-2 mr-1" style={{backgroundColor: '#cc0000', opacity: 0.7}}></span> &gt;100A</span>
                </span>
              </div>
            </h2>
            <div className="flex-1 min-h-[150px] relative border-2 border-gray-100 rounded overflow-hidden">
               {/* Generación de Grid CSS dinámico */}
               <div 
                 className="absolute inset-0 grid w-full h-full" 
                 style={{ 
                   gridTemplateColumns: `repeat(${data.mapa_terreno[0].length}, minmax(0, 1fr))`,
                   gridTemplateRows: `repeat(${data.mapa_terreno.length}, minmax(0, 1fr))`
                 }}
               >
                 {data.mapa_terreno.map((fila, y) => (
                    fila.map((cell, x) => {
                      let bgColor = COLORS.mapLow;
                      if(cell === 2) bgColor = COLORS.mapMed;
                      if(cell === 3) bgColor = COLORS.mapHigh;

                      const key = `${x},${y}`;
                      const currentAmp = historial[key];
                      let overlay = null;
                      
                      if (currentAmp !== undefined) {
                        let overColor;
                        let opacity;
                        if (currentAmp < 70) {
                          overColor = '#1a5c1a'; opacity = 0.6;
                        } else if (currentAmp <= 85) {
                          overColor = '#367C2B'; opacity = 0.5;
                        } else if (currentAmp <= 100) {
                          overColor = '#FFDE00'; opacity = 0.6;
                        } else {
                          overColor = '#cc0000'; opacity = 0.7;
                        }
                        overlay = (
                          <div className="absolute inset-0 flex items-center justify-center font-bold text-[10px]" style={{ backgroundColor: overColor, color: currentAmp <= 100 && currentAmp > 85 ? '#1A1A1A' : '#FFF' }}>
                            <div className="absolute inset-0" style={{ backgroundColor: overColor, opacity }}></div>
                            <span className="relative z-0 drop-shadow-md">{currentAmp.toFixed(2)}A</span>
                          </div>
                        );
                      }

                      return (
                        <div key={`${y}-${x}`} className="border border-white/50 relative transition-colors duration-1000" style={{backgroundColor: bgColor}}>
                          {overlay}
                          {/* Punto del tractor */}
                          {data.tractor_pos.x === x && data.tractor_pos.y === y && (
                            <div className="absolute inset-0 flex items-center justify-center z-10">
                              <div className="w-4 h-4 bg-[#1A1A1A] rounded-sm transform rotate-45 border-2 border-white shadow-lg animate-pulse"></div>
                            </div>
                          )}
                        </div>
                      )
                    })
                 ))}
               </div>
            </div>
          </div>

          {/* GRÁFICA DE AMPERAJE */}
          <div className="bg-white p-4 shadow-sm h-64">
            <h2 className="text-sm font-bold uppercase text-gray-500 mb-2 tracking-wider">Historial de Amperaje (Peak Shaving)</h2>
            <ResponsiveContainer width="100%" height="85%">
              <LineChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#EEE" />
                <XAxis dataKey="time" hide />
                <YAxis domain={[50, 130]} tick={{fontSize: 10, fill: '#999'}} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{fontWeight: 'bold', borderRadius: '0.5rem', border: 'none'}} />
                {/* Banda sombreada verde indicando zona óptima */}
                <ReferenceArea y1={65} y2={85} fill="#367C2B" fillOpacity={0.1} />
                <Line type="monotone" dataKey="Amp" stroke="#1A1A1A" strokeWidth={3} dot={{r:3, fill: '#FFDE00', strokeWidth: 2}} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

        </section>

        {/* PANEL DERECHO: Energía y Log */}
        <section className="flex flex-col gap-4">
          
          {/* NÚCLEO IA: Gestión de Energía por Prioridades */}
          <div className="bg-white p-4 shadow-sm border-t-4 border-[#1A1A1A]">
            <div className="flex justify-between items-start mb-3">
              <div>
                <h2 className="text-sm font-bold uppercase text-gray-500 tracking-wider">Gestión de Energía</h2>
                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wide">Núcleo IA · Prioridades</p>
              </div>
              <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${operacionInactiva ? 'bg-gray-100 text-gray-400' : redistribucionActiva ? 'bg-[#FFDE00] text-[#1A1A1A]' : 'bg-green-100 text-[#367C2B]'}`}>
                {operacionInactiva ? 'En espera' : redistribucionActiva ? 'Redistribuyendo' : 'Nominal'}
              </span>
            </div>

            {/* Balance del bus de potencia */}
            <div className="bg-[#1A1A1A] text-white rounded-md p-3 mb-3">
              <div className="flex justify-between items-center mb-2">
                <span className="text-[10px] uppercase tracking-wide text-white/60">Demanda / Disponible</span>
                <span className="text-sm font-bold">
                  <span className={energia.totalDemandado > energia.disponible ? 'text-[#FFDE00]' : 'text-[#7db356]'}>
                    {energia.totalDemandado.toFixed(1)}
                  </span>
                  <span className="text-white/40"> / {energia.disponible.toFixed(0)} kW</span>
                </span>
              </div>
              <div className="w-full h-2 bg-white/15 rounded-full overflow-hidden relative">
                {/* Línea de capacidad disponible */}
                <div
                  className="h-full bg-[#367C2B]"
                  style={{ width: `${energia.totalDemandado > 0 ? Math.min(100, (energia.totalAsignado / energia.totalDemandado) * 100) : 0}%` }}
                ></div>
              </div>
              <div className="text-[10px] text-white/50 mt-1">
                Asignado tras redistribución: <span className="text-white font-bold">{energia.totalAsignado.toFixed(1)} kW</span>
              </div>
            </div>

            {/* Asignación por subsistema */}
            <div className="space-y-2">
              {energia.items.map(item => {
                const pctAsignado = item.demandado > 0 ? (item.asignado / item.demandado) * 100 : 0;
                const reducido = item.demandado > 0 && pctAsignado < 99;
                const prioColor = item.prioridad === 1 ? '#367C2B' : item.prioridad === 2 ? '#1A1A1A' : '#9E9E9E';
                return (
                  <div key={item.id}>
                    <div className="flex justify-between items-center mb-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] font-bold text-white px-1.5 py-0.5 rounded" style={{ backgroundColor: prioColor }}>P{item.prioridad}</span>
                        <span className="text-xs font-bold text-gray-700">{item.nombre}</span>
                      </div>
                      <span className={`text-xs font-bold ${reducido ? 'text-[#b58900]' : 'text-gray-700'}`}>
                        {item.asignado.toFixed(1)} kW
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full transition-all duration-500"
                        style={{ width: `${pctAsignado}%`, backgroundColor: reducido ? '#FFDE00' : prioColor }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Aviso de la IA: qué redujo y por qué */}
            {operacionInactiva ? (
              <div className="mt-3 bg-gray-50 border-l-4 border-gray-300 p-3 rounded-r">
                <p className="text-xs text-gray-500 leading-snug">
                  Sin operación activa. Inicia la simulación para visualizar la gestión de energía en tiempo real.
                </p>
              </div>
            ) : redistribucionActiva ? (
              <div className="mt-3 bg-[#FFF9E6] border-l-4 border-[#FFDE00] p-3 rounded-r">
                <p className="text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">Acción de la IA</p>
                <p className="text-xs text-gray-700 leading-snug">
                  Pico de demanda detectado. Se redujo{' '}
                  {energia.reducciones.map((r, i) => (
                    <span key={r.id} className="font-bold text-[#1A1A1A]">
                      {r.nombre} {r.pct}%{i < energia.reducciones.length - 1 ? ', ' : ''}
                    </span>
                  ))}
                  {' '}para mantener sensores, control y tracción al 100%.
                </p>
              </div>
            ) : (
              <div className="mt-3 bg-gray-50 border-l-4 border-[#367C2B] p-3 rounded-r">
                <p className="text-xs text-gray-600 leading-snug">
                  Demanda dentro del límite del bus. Todos los subsistemas operan a plena potencia.
                </p>
              </div>
            )}

            {/* Leyenda de prioridades */}
            <div className="flex flex-wrap gap-3 justify-center mt-3 pt-3 border-t border-gray-100">
              <div className="flex items-center text-[10px] font-bold text-gray-500">
                <span className="w-2 h-2 rounded-sm mr-1" style={{ backgroundColor: '#367C2B' }}></span>P1 · Esencial
              </div>
              <div className="flex items-center text-[10px] font-bold text-gray-500">
                <span className="w-2 h-2 rounded-sm mr-1" style={{ backgroundColor: '#1A1A1A' }}></span>P2 · Operación
              </div>
              <div className="flex items-center text-[10px] font-bold text-gray-500">
                <span className="w-2 h-2 rounded-sm mr-1" style={{ backgroundColor: '#9E9E9E' }}></span>P3 · Reducible
              </div>
            </div>
          </div>

          {/* Log de operaciones */}
          <div className="bg-white p-4 shadow-sm flex-1 flex flex-col">
            <h2 className="text-sm font-bold uppercase text-gray-500 mb-3 tracking-wider">Log de Ajustes</h2>
            <ul className="space-y-3 flex-1 overflow-auto">
              {data.logs_recientes.length === 0 ? (
                <li className="text-xs font-mono text-gray-400 italic">Sin actividad. Inicia la simulación para registrar eventos.</li>
              ) : (
                data.logs_recientes.map((log, index) => (
                  <li key={index} className="text-xs font-mono border-b border-gray-100 pb-2 text-gray-700">
                    <span className="text-[#367C2B] mr-2">►</span>{log}
                  </li>
                ))
              )}
            </ul>
          </div>

          {/* Historial de Parcelas Completadas */}
          {parcelasCompletadas.length > 0 && (
            <div className="bg-white p-4 shadow-sm border-t-4 border-[#FFDE00]">
              <h2 className="text-sm font-bold uppercase text-gray-500 mb-3 tracking-wider">Parcelas Completadas</h2>
              <div className="space-y-3 max-h-64 overflow-auto">
                {parcelasCompletadas.map((parcela, index) => (
                  <div key={index} className="bg-[#F5F5F5] p-3 rounded-md border-l-4 border-[#367C2B]">
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-[10px] font-bold text-gray-500 uppercase">{parcela.fecha}</span>
                      <span className="text-xs font-bold text-[#367C2B]">#{parcelasCompletadas.length - index}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-gray-500 block text-[10px]">Amp Promedio</span>
                        <span className="font-bold text-[#1A1A1A]">{parcela.amperajePromedio} A</span>
                      </div>
                      <div>
                        <span className="text-gray-500 block text-[10px]">Amp Total</span>
                        <span className="font-bold text-[#1A1A1A]">{parcela.amperajeTotal} A</span>
                      </div>
                      <div>
                        <span className="text-gray-500 block text-[10px]">Celdas</span>
                        <span className="font-bold text-[#1A1A1A]">{parcela.celdasRecorridas}</span>
                      </div>
                      <div>
                        <span className="text-gray-500 block text-[10px]">Energía</span>
                        <span className="font-bold text-[#FFDE00]">{parcela.kwhTotal} kWh</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </section>
      </main>

      {/* Botón para Ver Último Reporte */}
      {parcelasCompletadas.length > 0 && reporteActual && (
        <button
          onClick={() => setMostrarReporte(true)}
          className="fixed bottom-6 right-6 bg-[#367C2B] hover:bg-[#2b6322] text-white font-semibold px-5 py-3 rounded-md shadow-lg flex items-center gap-2 text-sm tracking-wide transition-colors z-40 border border-[#2b6322]"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="7"/><rect x="12" y="6" width="3" height="11"/><rect x="17" y="13" width="3" height="4"/></svg>
          Reporte de Jornada
        </button>
      )}

      {/* MODAL DE SUBRUTINA PREVENTIVA (ALERTA) */}
      {data.alerta.activa && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6">
          <div className="bg-white max-w-2xl w-full border-8 border-[#367C2B] shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-300">
            
            <div className="p-8 text-center relative">
               <div className="w-20 h-20 bg-[#FFDE00] text-[#1A1A1A] rounded-full flex items-center justify-center mx-auto mb-6 shadow-md shadow-yellow-500/20">
                 {/* Icono de Peligro/Alerta SVG */}
                 <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
               </div>
               
               <h2 className="text-3xl font-extrabold text-[#1A1A1A] mb-4 tracking-tight uppercase leading-tight">
                 {data.alerta.mensaje}
               </h2>

               <p className="text-gray-500 font-bold uppercase tracking-wider text-sm mb-8">Pico resistivo detectado en la matriz a +2m.</p>
               
               {/* Diagrama SVG simple del cambio */}
               <div className="my-8 flex justify-center items-center h-24">
                   <svg width="200" height="80" viewBox="0 0 200 80">
                     {/* Suelo base */}
                     <line x1="0" y1="40" x2="200" y2="40" stroke="#8D6E63" strokeWidth="4" strokeDasharray="5,5" />
                     {/* Implemento actual */}
                     <g opacity="0.4">
                       <rect x="50" y="10" width="8" height="58" fill="#1A1A1A" />
                       <path d="M40,68 L66,68 L53,80 Z" fill="#1A1A1A" />
                     </g>
                     {/* Implemento propuesto */}
                     <g transform="translate(80, -15)">
                       <rect x="50" y="10" width="8" height="58" fill="#367C2B" />
                       <path d="M40,68 L66,68 L53,80 Z" fill="#367C2B" />
                     </g>
                     <path d="M70,55 L110,40" stroke="#FFDE00" strokeWidth="3" markerEnd="url(#arrow)" />
                     <defs>
                       <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                         <path d="M 0 0 L 10 5 L 0 10 z" fill="#FFDE00" />
                       </marker>
                     </defs>
                   </svg>
               </div>

               <div className="grid grid-cols-2 gap-6 mt-6">
                 <button 
                   onClick={handleAceptarAjuste}
                   className="bg-[#FFDE00] hover:bg-yellow-400 text-[#1A1A1A] font-black text-xl py-6 rounded-lg uppercase tracking-wider transition-colors shadow-lg active:scale-95"
                 >
                   SÍ, AJUSTAR
                 </button>
                 <button 
                   onClick={handleRechazarAjuste}
                   className="bg-[#F5F5F5] hover:bg-gray-300 text-[#1A1A1A] font-bold text-xl py-6 rounded-lg uppercase tracking-wider transition-colors active:scale-95 border-2 border-gray-200"
                 >
                   YO LO HAGO
                 </button>
               </div>

            </div>

            {/* Progress/Countdown Bar Container */}
            <div className="w-full bg-gray-200 h-3 relative">
               <div 
                 className="absolute left-0 top-0 h-full bg-[#1A1A1A] transition-all duration-1000 ease-linear"
                 style={{ width: `${(data.alerta.countdown / data.alerta.max_countdown) * 100}%` }}
               ></div>
            </div>
            <div className="p-3 bg-gray-100 text-center text-xs font-bold text-gray-500 uppercase tracking-widest">
              Si no respondes en {data.alerta.countdown}s, el sistema ajustará automáticamente.
            </div>

          </div>
        </div>
      )}

      {/* MODAL DE REPORTE DE EFICIENCIA */}
      {mostrarReporte && reporteActual && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white max-w-4xl w-full max-h-[92vh] overflow-y-auto shadow-2xl border-t-4 border-[#367C2B]">

            {/* Encabezado */}
            <div className="bg-[#1A1A1A] text-white px-6 py-5 flex justify-between items-center sticky top-0 z-10">
              <div className="flex items-center gap-4">
                <div className="w-px h-10 bg-[#FFDE00]"></div>
                <div>
                  <h2 className="text-xl font-bold uppercase tracking-wider">Reporte de Jornada</h2>
                  <p className="text-white/60 text-xs mt-0.5 tracking-wide">FieldSense · Sistema Peak Shaving</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-white/60 text-xs font-medium hidden md:block">{reporteActual.fecha}</span>
                <button
                  onClick={() => setMostrarReporte(false)}
                  className="text-white/60 hover:text-white text-xl leading-none transition-colors"
                  aria-label="Cerrar"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="p-6 space-y-6">

              {/* Resumen ejecutivo: beneficio neto */}
              <div className="border border-gray-200">
                <div className="bg-[#367C2B] text-white px-5 py-3">
                  <h3 className="text-sm font-bold uppercase tracking-wider">Beneficio neto de la jornada</h3>
                </div>
                <div className="p-5 flex flex-col md:flex-row md:items-end md:justify-between gap-4">
                  <div>
                    <p className="text-sm text-gray-500 mb-1">Pérdidas evitadas por el sistema</p>
                    <p className="text-4xl font-bold text-[#1A1A1A]">
                      ${reporteActual.costos.total.toLocaleString('es-MX', { maximumFractionDigits: 0 })} <span className="text-lg font-semibold text-gray-500">MXN</span>
                    </p>
                  </div>
                  <div className="text-sm text-gray-600 md:text-right">
                    <p>{reporteActual.impacto.minutos} min de operación productiva conservados</p>
                    <p>{reporteActual.conSistema.ajustesAutomaticos} ajustes automáticos aplicados</p>
                  </div>
                </div>
              </div>

              {/* Desglose de costos evitados */}
              <div className="border border-gray-200">
                <div className="bg-gray-100 px-5 py-3 border-b border-gray-200">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-gray-700">Desglose de pérdidas evitadas</h3>
                </div>
                <div className="divide-y divide-gray-100">
                  <div className="flex justify-between items-center px-5 py-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">Energía desperdiciada</p>
                      <p className="text-xs text-gray-500">{reporteActual.impacto.kwh.toFixed(2)} kWh de sobreconsumo evitado</p>
                    </div>
                    <span className="text-lg font-bold text-[#1A1A1A]">${reporteActual.costos.energia.toLocaleString('es-MX', { maximumFractionDigits: 0 })}</span>
                  </div>
                  <div className="flex justify-between items-center px-5 py-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">Tiempo improductivo</p>
                      <p className="text-xs text-gray-500">{reporteActual.impacto.minutos} min de paro = menos superficie cosechada</p>
                    </div>
                    <span className="text-lg font-bold text-[#1A1A1A]">${reporteActual.costos.tiempo.toLocaleString('es-MX', { maximumFractionDigits: 0 })}</span>
                  </div>
                  <div className="flex justify-between items-center px-5 py-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">Rendimiento perdido</p>
                      <p className="text-xs text-gray-500">{reporteActual.impacto.zonas} zonas con labor deficiente evitadas</p>
                    </div>
                    <span className="text-lg font-bold text-[#1A1A1A]">${reporteActual.costos.zonas.toLocaleString('es-MX', { maximumFractionDigits: 0 })}</span>
                  </div>
                  <div className="flex justify-between items-center px-5 py-3 bg-gray-50">
                    <p className="text-sm font-bold uppercase tracking-wide text-gray-700">Total</p>
                    <span className="text-xl font-bold text-[#367C2B]">${reporteActual.costos.total.toLocaleString('es-MX', { maximumFractionDigits: 0 })} MXN</span>
                  </div>
                </div>
              </div>

              {/* Comparación con vs sin sistema */}
              <div className="border border-gray-200">
                <div className="bg-gray-100 px-5 py-3 border-b border-gray-200">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-gray-700">Comparativa operativa</h3>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                      <th className="text-left font-semibold px-5 py-3">Indicador</th>
                      <th className="text-right font-semibold px-5 py-3 text-[#367C2B]">Con FieldSense</th>
                      <th className="text-right font-semibold px-5 py-3 text-gray-500">Sin sistema</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td className="px-5 py-3 text-gray-700">Tiempo detenido</td>
                      <td className="px-5 py-3 text-right font-bold text-[#367C2B]">0 min</td>
                      <td className="px-5 py-3 text-right font-bold text-gray-700">{reporteActual.sinSistema.minutosParados} min</td>
                    </tr>
                    <tr>
                      <td className="px-5 py-3 text-gray-700">Zonas con labor deficiente</td>
                      <td className="px-5 py-3 text-right font-bold text-[#367C2B]">0</td>
                      <td className="px-5 py-3 text-right font-bold text-gray-700">{reporteActual.sinSistema.zonasDeficientes}</td>
                    </tr>
                    <tr>
                      <td className="px-5 py-3 text-gray-700">Energía consumida</td>
                      <td className="px-5 py-3 text-right font-bold text-[#367C2B]">{reporteActual.conSistema.kwhConsumidos.toFixed(2)} kWh</td>
                      <td className="px-5 py-3 text-right font-bold text-gray-700">{reporteActual.sinSistema.kwhConsumidos.toFixed(2)} kWh</td>
                    </tr>
                    <tr>
                      <td className="px-5 py-3 text-gray-700">Batería restante</td>
                      <td className="px-5 py-3 text-right font-bold text-[#367C2B]">{reporteActual.conSistema.bateriaRestante.toFixed(1)}%</td>
                      <td className="px-5 py-3 text-right font-bold text-gray-700">{reporteActual.sinSistema.bateriaRestante.toFixed(1)}%</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Datos de la parcela */}
              <div className="border border-gray-200">
                <div className="bg-gray-100 px-5 py-3 border-b border-gray-200">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-gray-700">Datos de la parcela</h3>
                </div>
                <div className="grid grid-cols-3 divide-x divide-gray-100">
                  <div className="px-5 py-4">
                    <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Celdas recorridas</p>
                    <p className="text-2xl font-bold text-[#1A1A1A]">{reporteActual.parcela.celdasRecorridas}</p>
                  </div>
                  <div className="px-5 py-4">
                    <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Tiempo de jornada</p>
                    <p className="text-2xl font-bold text-[#1A1A1A]">{reporteActual.parcela.tiempoTotal.toFixed(0)} <span className="text-base font-semibold text-gray-500">min</span></p>
                  </div>
                  <div className="px-5 py-4">
                    <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Amperaje promedio</p>
                    <p className="text-2xl font-bold text-[#1A1A1A]">{reporteActual.parcela.amperajePromedio.toFixed(1)} <span className="text-base font-semibold text-gray-500">A</span></p>
                  </div>
                </div>
              </div>

              <p className="text-xs text-gray-400 leading-relaxed">
                Estimaciones basadas en tarifa eléctrica industrial, costo de operación por minuto (operador, máquina y superficie no cosechada) y pérdida de rendimiento por labor deficiente. Valores en pesos mexicanos.
              </p>

              {/* Botón de Cerrar */}
              <button
                onClick={() => setMostrarReporte(false)}
                className="w-full bg-[#367C2B] hover:bg-[#2b6322] text-white font-semibold text-sm py-3 uppercase tracking-wider transition-colors"
              >
                Cerrar
              </button>

            </div>

          </div>
        </div>
      )}

    </div>
  );
}
