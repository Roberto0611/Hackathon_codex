import React, { useState, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
  PieChart,
  Pie,
  Cell
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

const PIE_COLORS = [COLORS.green, COLORS.yellow, '#4A4A4A', '#9E9E9E'];

// --- Estado Inicial Mock ---
const INITIAL_STATE = {
  posicion: { x: 4, y: 7 },
  amperaje: { actual: 87, optimo: 75, maximo: 120 },
  profundidad: { actual: 28, recomendada: 24 },
  velocidad: 6.2,
  rpm: 1800,
  bateria: { porcentaje: 72, horas_restantes: 8.4 },
  kw_subsistemas: {
    implemento: 32,
    traccion: 28,
    hidraulica: 12,
    cabina: 8
  },
  estado: "ajustando",
  ajustes_automaticos: 15,
  kwh_ahorrados: 4.2,
  historial_amperaje: [72, 75, 80, 87, 91, 88, 85, 83, 87],
  alerta: {
    activa: true,
    tipo: "peak_shaving",
    mensaje: "El sistema quiere bajar la profundidad de 28cm a 24cm",
    countdown: 7,
    max_countdown: 7
  },
  mapa_terreno: [
    [1, 1, 2, 2, 3],
    [1, 2, 2, 3, 3],
    [2, 2, 3, 3, 2],
    [1, 1, 2, 2, 1]
  ],
  tractor_pos: { x: 2, y: 3 }, // x=columna, y=fila (0-indexed)
  logs_recientes: [
    "10:42 Ajuste preventivo: V -0.5km/h",
    "10:35 Peak alert: Profundidad -2cm",
    "10:15 Inicio de sesión de calibración"
  ]
};

export default function App() {
  const [data, setData] = useState(INITIAL_STATE);
  const [historial, setHistorial] = useState<Record<string, number>>({});
  const [parcelasCompletadas, setParcelasCompletadas] = useState<Array<{
    fecha: string;
    amperajePromedio: number;
    amperajeTotal: number;
    celdasRecorridas: number;
    kwhTotal: number;
  }>>([]);
  
  // --- Simulación de WebSocket (Tiempo Real) ---
  useEffect(() => { 
    const h=(e)=>{
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
            const ch={};
            for(const[k,v] of Object.entries(t.historial_mapa)){
              ch[k]=v.amperaje;
            }
            setHistorial(ch);
          }
        }catch(err){}
      }
    };
    window.addEventListener('storage',h);
    return()=>window.removeEventListener('storage',h); 
  }, []);

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
  const pieData = Object.entries(data.kw_subsistemas).map(([key, value]) => ({ name: key.toUpperCase(), value }));

  return (
    <div className="min-h-screen bg-[#F5F5F5] text-[#1A1A1A] font-sans relative overflow-hidden flex flex-col">
      
      {/* HEADER */}
      <header className="bg-[#367C2B] text-white px-6 py-4 flex justify-between items-center shadow-md z-10">
        <div className="flex items-center gap-4">
          {/* Logo simulado por IMG como requerido */}
          <img src="logo.png" alt="John Deere Logo" className="h-8 bg-white p-1 rounded-sm object-contain" onError={(e) => { e.target.style.display='none'; e.target.nextSibling.style.display='block'; }} />
          <div style={{display:'none'}} className="font-bold text-2xl tracking-widest text-[#FFDE00]">JOHN DEERE</div>
          <div className="w-px h-6 bg-white/30 mx-2"></div>
          <h1 className="text-xl font-bold uppercase tracking-wider">EV Peak Shaver</h1>
          <span className="ml-4 px-3 py-1 bg-white text-[#367C2B] rounded-full text-xs font-bold uppercase">Online</span>
        </div>
        <div className="flex gap-6 text-sm font-bold">
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
          
          {/* Distribución de energía */}
          <div className="bg-white p-4 shadow-sm">
            <h2 className="text-sm font-bold uppercase text-gray-500 mb-2 tracking-wider">Demanda (kW)</h2>
            <div className="h-40 w-full mb-2">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={65}
                    paddingAngle={2}
                    dataKey="value"
                    stroke="none"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => [`${value} kW`, 'Consumo']} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              {pieData.map((entry, index) => (
                <div key={entry.name} className="flex items-center text-[10px] font-bold text-gray-600">
                  <span className="w-2 h-2 rounded-full mr-1" style={{backgroundColor: PIE_COLORS[index]}}></span>
                  {entry.name}
                </div>
              ))}
            </div>
          </div>

          {/* Log de operaciones */}
          <div className="bg-white p-4 shadow-sm flex-1 flex flex-col">
            <h2 className="text-sm font-bold uppercase text-gray-500 mb-3 tracking-wider">Log de Ajustes</h2>
            <ul className="space-y-3 flex-1 overflow-auto">
              {data.logs_recientes.map((log, index) => (
                <li key={index} className="text-xs font-mono border-b border-gray-100 pb-2 text-gray-700">
                  <span className="text-[#367C2B] mr-2">►</span>{log}
                </li>
              ))}
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

    </div>
  );
}
