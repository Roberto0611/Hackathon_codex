/**
 * MOTOR DE FÍSICA PARA TRACTOR EV PEAK SHAVER
 * ===========================================
 * Este motor calcula en tiempo real el consumo energético y aplica
 * estrategias predictivas y reactivas de Peak Shaving para maximizar
 * la autonomía del tractor agrícola eléctrico.
 *
 * Ecuaciones implementadas:
 * 1. Resistencia (R) = k * a * d * n  (kN)
 * 2. Potencia (P) = (R * v) / eta     (Watts -> kW)
 * 3. Corriente (I) = P / V            (Amperes)
 *
 * NOTA: Este motor es "puro" matemáticamente y no maneja timers / intervalos.
 * Cada llamada a tick() avanza el estado interno lógicamente basada en el mapa.
 */

export const TERRAIN_K = {
  NORMAL: 30,
  HIERBA: 20,
  SECO: 15,
  LODO: 80,
  PIEDRA: 110,
  INUNDADO: 120
};

export default class PhysicsEngine {
  /**
   * @param {Object} config - Configuración inicial del motor
   * @param {number[][]|string[][]} config.mapa - Matriz 2D representando el mapa (valores K o strings)
   * @param {number} config.a - Ancho de trabajo del implemento (metros)
   * @param {number} config.n - Número de cuerpos del implemento
   * @param {number} config.d_inicial - Profundidad de trabajo inicial (metros, eje. 0.20 para 20cm)
   * @param {number} config.velocidad - Velocidad de avance (km/h)
   * @param {number} config.eta - Eficiencia de transmisión (0.0 a 1.0)
   * @param {number} config.voltaje - Voltaje del generador/batería (ej. 400, 700)
   * @param {number} config.max_amperaje - Umbral máximo de amperios antes del peak shaving reactivo
   */
  constructor(config) {
    if (!config || !config.mapa || config.mapa.length === 0 || config.mapa[0].length === 0) {
      throw new Error("El mapa no puede estar vacío");
    }

    // Convertir el mapa de strings a valores K asegurando formato correcto
    this.mapa = config.mapa.map(row => 
      row.map(cell => typeof cell === 'string' && TERRAIN_K[cell.toUpperCase()] ? TERRAIN_K[cell.toUpperCase()] : cell)
    );

    this.rows = this.mapa.length;
    this.cols = this.mapa[0].length;
    this.total_celdas = this.rows * this.cols;

    // Constantes físicas del tractor
    this.a = config.a || 1.5;
    this.n = config.n || 4;
    this.eta = config.eta || 0.85;
    this.V = config.voltaje || 700;
    
    // Parámetros dinámicos
    this.profundidad_original_m = config.d_inicial || 0.20;
    this.d = config.d_inicial || 0.20;
    this.velocidad = config.velocidad || 6; 
    this.max_amperaje = config.max_amperaje || 120;

    // Estado interno inicial
    this.pos = { x: -1, y: 0 }; // Empezamos "fuera" del grid
    this.celdas_recorridas = 0;
    this.pausado = false;
    this.bateria_max = 150; // 150 kWh
    this.bateria_actual = 150;
    this.historial_energia_celda = [];
    this.historial_amperaje = [];
    this.kwh_ahorrados = 0;
    this.ajustes_automaticos = 0;
    this.ajustes_predictivos = 0;
    this.ajustes_reactivos = 0;
    
    this.estado = "optimo";
    this.alerta = { activa: false, tipo: "", mensaje: "", countdown: 0 };
    
    this.last_amperaje_display = 75; // Para la inercia
    this.celda_mas_dificil = { x: 0, y: 0, amperaje: 0, tipo: "N/A" };
  }

  /**
   * Resetea la simulación al estado inicial.
   */
  resetear() {
    this.pos = { x: -1, y: 0 };
    this.celdas_recorridas = 0;
    this.bateria_actual = this.bateria_max;
    this.historial_energia_celda = [];
    this.historial_amperaje = [];
    this.kwh_ahorrados = 0;
    this.ajustes_automaticos = 0;
    this.ajustes_predictivos = 0;
    this.ajustes_reactivos = 0;
    this.d = this.profundidad_original_m;
    this.estado = "optimo";
    this.alerta = { activa: false, tipo: "", mensaje: "", countdown: 0 };
    this.last_amperaje_display = 75;
    this.celda_mas_dificil = { x: 0, y: 0, amperaje: 0, tipo: "N/A" };
  }

  /**
   * Pausa el motor (simplemente levanta flag, para que un caller respetuoso lo lea).
   */
  pausar() {
    this.pausado = true;
  }

  /**
   * Reanuda la simulación.
   */
  reanudar() {
    this.pausado = false;
  }

  /**
   * Permite inyectar parámetros nuevos (ej. el usuario cambia profundidad desde la UI)
   * @param {string} key - Clave del parámetro (d, velocidad, max_amperaje, etc)
   * @param {number} value - Nuevo valor
   */
  setParametro(key, value) {
    if (key === 'd' || key === 'profundidad') {
      this.d = value;
      this.profundidad_original_m = value;
    } else if (this.hasOwnProperty(key)) {
      this[key] = value;
    }
  }

  /**
   * Obtiene la siguiente posición en la matriz siguiendo la 
   * lógica Boustrophedon (serpentina).
   * @param {Object} current_pos - Posición (x,y) actual 
   * @returns {Object|null} Objeto {x,y} o null si acabó el mapa
   */
  getSiguientePosicion(current_pos) {
    let { x, y } = current_pos;
    if (x === -1) return { x: 0, y: 0 }; // Start
    
    if (y % 2 === 0) {
      if (x < this.cols - 1) x++;
      else y++;
    } else {
      if (x > 0) x--;
      else y++;
    }
    
    if (y >= this.rows) return null;
    return { x, y };
  }

  /**
   * Mira n celdas adelante del punto especificado.
   * @param {Object} pos - Punto origen (x,y)
   * @param {number} n - Celdas a proyectar
   * @returns {Array<Object>} Arreglo con hasta 'n' próximos puntos {x,y}
   */
  getTrayectoriaAdelante(pos, n) {
    let futura = this.getSiguientePosicion(pos);
    let tray = [];
    let cur = { ...futura };
    while (cur && tray.length < n) {
      tray.push(cur);
      cur = this.getSiguientePosicion(cur);
    }
    return tray;
  }

  getTrayectoriaCompleta() {
    let tray = [];
    let cur = { x: -1, y: 0 };
    cur = this.getSiguientePosicion(cur);
    while (cur) {
      tray.push(cur);
      cur = this.getSiguientePosicion(cur);
    }
    return tray;
  }

  /**
   * Retorna el estado puro sin avanzar el bloque lógicamente.
   */
  getEstado() {
    // Para simplificar, tick() devuelve el estado de forma inmutable, 
    // pero si se necesita consultar externamente implementamos este mirror temporal.
    return {
      posicion: this.pos,
      bateria: { porcentaje: (this.bateria_actual / this.bateria_max)*100 }
    };
  }

  /**
   * Calcula I para un un set de parámetros.
   */
  _calcularRPI(k_cell, d_m, vel_kmh) {
    // Ruido realista: +-7.5% de variación para dar naturalidad a la simulación
    const k_real = k_cell * (1 + (Math.random() - 0.5) * 0.15);
    
    const R_kN = k_real * this.a * d_m * this.n;
    const R_N = R_kN * 1000;
    const v_ms = vel_kmh / 3.6;
    const P_watts = (R_N * v_ms) / this.eta;
    const I = P_watts / this.V;
    
    return { I, P_kw: P_watts / 1000, R_N, k_usado: k_real };
  }

  /**
   * Función central que avanza la simulación una celda y retorna toda la telemetría calculada.
   * Aplica física, Peak Shaving y modelado inético.
   * @returns {Object} El Snapshot de estado solicitado en el requerimiento.
   */
  tick() {
    if (this.pausado) return null;

    let fue_predictivo = false;
    let next_pos = this.getSiguientePosicion(this.pos);
    
    if (!next_pos) {
      // END OF FIELD
      const kwh_consumidos_total = this.bateria_max - this.bateria_actual;
      const t_celda = 1 / (this.velocidad / 3.6); // tiempo en recorrer 1 meta? Asumiendo celda 1m.
      const dur_segundos = this.celdas_recorridas * t_celda; 
      
      const reporte_final = {
        duracion_segundos: dur_segundos,
        kwh_consumidos_total: parseFloat(kwh_consumidos_total.toFixed(2)),
        kwh_ahorrados_total: parseFloat(this.kwh_ahorrados.toFixed(2)),
        porcentaje_ahorro: parseFloat(((this.kwh_ahorrados / (kwh_consumidos_total + this.kwh_ahorrados + 0.001)) * 100).toFixed(1)),
        ajustes_automaticos_total: this.ajustes_automaticos,
        ajustes_predictivos: this.ajustes_predictivos,
        ajustes_reactivos: this.ajustes_reactivos,
        celda_mas_dificil: this.celda_mas_dificil,
        eficiencia_promedio: parseFloat(this.eta.toFixed(2)),
        bateria_restante: parseFloat(this.bateria_actual.toFixed(2)),
        resumen_texto:
         \`Jornada completada. Se ahorraron \${this.kwh_ahorrados.toFixed(1)} kWh gracias al sistema Peak Shaving.\`
      };

      return {
        completado: true,
        reporte_final
      };
    }

    // Mover 
    this.pos = next_pos;
    this.celdas_recorridas++;
    const k_actual = this.mapa[this.pos.y][this.pos.x];

    // ==========================================
    // 1. PEAK SHAVING PREDICTIVO (Mirar adelante)
    // ==========================================
    let tray_adelante = this.getTrayectoriaAdelante(this.pos, 3);
    for (const celda_futura of tray_adelante) {
      const k_futuro = this.mapa[celda_futura.y][celda_futura.x];
      const test = this._calcularRPI(k_futuro, this.d, this.velocidad);
      if (test.I > this.max_amperaje * 0.85) {
        // Reducir d previniendo el golpe (1 cm = 0.01m)
        if (this.d > 0.05) { // clamp para no sacar el implemento
          this.d -= 0.01;
          this.ajustes_predictivos++;
          this.ajustes_automaticos++;
          fue_predictivo = true;
        }
        break; // ya ajustamos
      }
    }

    // ==========================================
    // 2. FÍSICA CELDA ACTUAL
    // ==========================================
    let sim = this._calcularRPI(k_actual, this.d, this.velocidad);
    
    // ==========================================
    // 3. PEAK SHAVING REACTIVO
    // ==========================================
    let reactivo_trigger = false;
    let fallbackVelocidad = this.velocidad;

    if (sim.I > this.max_amperaje) {
      // Intentar hasta 3 veces
      for (let intento = 0; intento < 3; intento++) {
         if (this.d <= 0.05) break; 
         this.d -= 0.02; // Bajar 2 cm = 0.02m
         sim = this._calcularRPI(k_actual, this.d, fallbackVelocidad);
         if (sim.I <= this.max_amperaje) break;
      }
      
      if (sim.I > this.max_amperaje) {
         // Si sigue muy alto reducir marcha
         fallbackVelocidad = Math.max(1, fallbackVelocidad - 0.5);
         sim = this._calcularRPI(k_actual, this.d, fallbackVelocidad);
         this.alerta = { activa: true, tipo: "peak_shaving", mensaje: "Sobrecarga severa. Reduciendo marcha.", countdown: 3 };
         this.estado = "alerta";
      } else {
         this.estado = "ajustando";
      }
      this.ajustes_reactivos++;
      this.ajustes_automaticos++;
      reactivo_trigger = true;
    } else {
      // Recuperar status si estábamos relax
      if (this.estado !== "optimo" && !this.alerta.activa) {
         // Intentar restaurar profundidad gradualmente hacia origen
         if (this.d < this.profundidad_original_m) {
           this.d = Math.min(this.profundidad_original_m, this.d + 0.01);
         }
         this.estado = "optimo";
      }
    }

    this.velocidad = fallbackVelocidad;

    // Calcular ahorro (contra escenario "bruto")
    const bruto = this._calcularRPI(k_actual, this.profundidad_original_m, configVel_orig || 6); // todo: track vel orig
    const tiempo_celda_seg = 1 / (this.velocidad / 3.6); 
    const tiempo_bruto_seg = 1 / (6 / 3.6); 

    const energia_celda_kwh = (sim.P_kw * tiempo_celda_seg) / 3600; 
    const energia_bruta_kwh = (bruto.P_kw * tiempo_bruto_seg) / 3600;
    
    this.kwh_ahorrados += (energia_bruta_kwh - energia_celda_kwh);
    
    // Inercia UI
    this.last_amperaje_display = (this.last_amperaje_display * 0.3) + (sim.I * 0.7);

    // Batería Updates
    this.bateria_actual = Math.max(0, this.bateria_actual - energia_celda_kwh);
    this.historial_energia_celda.push(energia_celda_kwh);
    if (this.historial_energia_celda.length > 10) this.historial_energia_celda.shift();

    const consumo_promedio = this.historial_energia_celda.reduce((a,b)=>a+b,0) / this.historial_energia_celda.length;
    let horas_restantes = 99;
    if (consumo_promedio > 0) {
       const consumo_por_h = consumo_promedio * 3600 / tiempo_celda_seg;
       horas_restantes = this.bateria_actual / consumo_por_h;
       horas_restantes = isFinite(horas_restantes) ? horas_restantes : 99;
    }

    // RPM
    const rpm_base = 1800;
    let comp_o_rpm = this.last_amperaje_display > 75 
        ? rpm_base - ((this.last_amperaje_display - 75) * 2) 
         : rpm_base + ((75 - this.last_amperaje_display) * 1);
    comp_o_rpm = Math.max(1200, Math.min(2200, comp_o_rpm));

    // Stats history
    this.historial_amperaje.push(parseFloat(this.last_amperaje_display.toFixed(1)));
    if (this.historial_amperaje.length > 20) this.historial_amperaje.shift();

    if (sim.I > this.celda_mas_dificil.amperaje) {
       this.celda_mas_dificil = { x: this.pos.x, y: this.pos.y, amperaje: sim.I, tipo: k_actual.toString() };
    }

    const t_kw_restantes = this.bateria_actual;
    const t_porcentaje = (this.bateria_actual / this.bateria_max) * 100;
    
    // Alarma decrement
    if (this.alerta.activa && this.alerta.countdown > 0) {
       this.alerta.countdown--;
       if (this.alerta.countdown <= 0) {
          this.alerta.activa = false;
       }
    }

    let predict_next = 75;
    if (tray_adelante.length > 0) {
      predict_next = this._calcularRPI(this.mapa[tray_adelante[0].y][tray_adelante[0].x], this.d, this.velocidad).I;
    }
    
    // Construct final snapshot required by spec
    return {
      posicion: { ...this.pos },
      amperaje: {
        actual: parseFloat(this.last_amperaje_display.toFixed(1)),
        raw: parseFloat(sim.I.toFixed(1)),
        optimo: 75.0,
        maximo: this.max_amperaje,
        predicho_proxima: parseFloat(predict_next.toFixed(1))
      },
      profundidad: {
        actual: parseFloat((this.d * 100).toFixed(1)), // retornar en cm
        recomendada: parseFloat((this.d * 100).toFixed(1)),
        inicial: parseFloat((this.profundidad_original_m * 100).toFixed(1))
      },
      velocidad: parseFloat(this.velocidad.toFixed(1)),
      rpm: Math.round(comp_o_rpm),
      bateria: {
        porcentaje: parseFloat(t_porcentaje.toFixed(1)),
        kwh_restantes: parseFloat(t_kw_restantes.toFixed(1)),
        horas_restantes: parseFloat(horas_restantes.toFixed(1)),
        kwh_consumidos: parseFloat((this.bateria_max - this.bateria_actual).toFixed(2))
      },
      kw_subsistemas: {
        implemento: parseFloat((sim.P_kw * 0.60).toFixed(1)),
        traccion: parseFloat((sim.P_kw * 0.25).toFixed(1)),
        hidraulica: parseFloat((sim.P_kw * 0.10).toFixed(1)),
        cabina: parseFloat(Math.max(3, sim.P_kw * 0.05).toFixed(1))
      },
      estado: this.estado,
      ajustes_automaticos: this.ajustes_automaticos,
      ajuste_fue_predictivo: fue_predictivo,
      kwh_ahorrados: parseFloat(this.kwh_ahorrados.toFixed(2)),
      historial_amperaje: [...this.historial_amperaje],
      alerta: { ...this.alerta },
      mapa_terreno: this.mapa,
      tractor_pos: { ...this.pos },
      trayectoria_adelante: tray_adelante,
      completado: false,
      celdas_recorridas: this.celdas_recorridas,
      total_celdas: this.total_celdas,
      reporte_final: null
    };
  }
}
