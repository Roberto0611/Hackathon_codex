# Contexto del Proyecto - Sistema de Tractores Eléctricos John Deere

## Descripción General
Sistema de monitoreo y simulación para tractores eléctricos con tecnología de **Peak Shaving** (reducción de picos de consumo). El proyecto se divide en dos componentes principales que se comunican mediante `localStorage`.

---

## Arquitectura del Sistema

### Stack Tecnológico
- **Frontend**: React 19.2.6 + TypeScript 6.0.2
- **Build Tool**: Vite 8.0.12
- **Routing**: React Router DOM 7.16.0
- **Gráficas**: Recharts 3.8.1
- **Estilos**: Tailwind CSS 4.3.0
- **Identidad Visual**: Colores John Deere (Verde #367C2B, Amarillo #FFDE00)

### Estructura de Rutas
- `/` - Dashboard del Operador (App.tsx)
- `/simulador` - Simulador de Terreno (SimuladorTerreno.tsx)

---

## Componente 1: Dashboard del Operador (`App.tsx`)

### Propósito
Interfaz que ve el **operador del tractor** en tiempo real durante la operación en campo.

### Funcionalidades Principales

#### 1. **Monitoreo en Tiempo Real**
- **Amperaje actual** vs óptimo vs máximo
- **Profundidad de trabajo** actual vs recomendada
- **Velocidad** y **RPM** del motor
- **Batería**: porcentaje y horas restantes
- **Distribución de energía** por subsistemas (implemento, tracción, hidráulica, cabina)

#### 2. **Sistema de Alertas Peak Shaving**
Cuando se detecta un pico de consumo:
- Modal con **countdown de 7 segundos**
- Propone ajuste automático (ej: reducir profundidad de 28cm a 24cm)
- Operador puede:
  - **Aceptar**: Sistema ajusta automáticamente
  - **Rechazar**: Operador toma control manual
- Si no hay respuesta, el sistema ajusta automáticamente

#### 3. **Visualizaciones**
- **Gauge de amperaje** (simulado con CSS/SVG)
- **Gráfica de historial** de amperaje con banda óptima
- **Mapa de terreno** con posición del tractor en tiempo real
- **Gráfica de torta** de distribución de energía (kW)
- **Log de ajustes** recientes

#### 4. **Métricas Acumuladas**
- kWh ahorrados
- Número de ajustes automáticos
- Horas de batería restantes

### Comunicación
Escucha eventos `storage` en `localStorage` con clave `tractor_telemetry` para recibir datos del simulador.

---

## Componente 2: Simulador de Terreno (`SimuladorTerreno.tsx`)

### Propósito
Herramienta de **simulación y pruebas** para generar escenarios de terreno y simular el comportamiento del tractor.

### Funcionalidades Principales

#### 1. **Editor de Terreno**
- Grid configurable (5x5 hasta 15x15)
- 6 tipos de terreno con diferentes resistencias (k):
  - 🟫 **Normal** (k=30)
  - 🌿 **Hierba** (k=20)
  - ☀️ **Seco** (k=15)
  - 💧 **Lodo** (k=80)
  - 🪨 **Piedra** (k=110)
  - 🌊 **Inundado** (k=120)
- Herramientas: pincel, limpiar, aleatorio

#### 2. **Parámetros del Implemento**
- **Ancho de trabajo (a)**: 0.5-3m
- **Número de cuerpos (n)**: 1-8
- **Profundidad inicial (d)**: 10-40cm
- **Velocidad**: 3-12 km/h

#### 3. **Parámetros del Tractor**
- **Voltaje del sistema**: 400V / 700V / 800V
- **Eficiencia de transmisión (η)**: 70-95%
- **Amperaje máximo permitido**: 80-150A

#### 4. **Motor de Simulación**

##### Fórmulas Físicas
```
R = k × a × d × n          (Resistencia total)
P = (R × V) / η            (Potencia en Watts)
I = P / Voltaje            (Amperaje)
```

##### Algoritmo Peak Shaving
```
MIENTRAS (Amperaje > Máximo) Y (Profundidad > 10cm):
  Profundidad -= 2cm
  Recalcular Amperaje
  Incrementar contador de ajustes
```

##### Cálculo de Energía
```
Tiempo por celda (h) = 0.001 km / Velocidad (km/h)
kW = (Amperaje × Voltaje) / 1000
kWh = kW × Tiempo
```

#### 5. **Patrón de Movimiento**
El tractor se mueve en patrón **boustrophedon** (ida y vuelta):
- Filas pares: izquierda → derecha
- Filas impares: derecha → izquierda

#### 6. **Visualización en Tiempo Real**
- Emoji 🚜 marca posición actual
- Celdas visitadas muestran amperaje consumido con código de colores:
  - Verde oscuro: <70A
  - Verde: 70-85A
  - Amarillo: 85-100A
  - Rojo: >100A

#### 7. **Controles de Simulación**
- ▶ Iniciar / Reanudar
- ⏸ Pausar
- ⏹ Reset
- Velocidad: Lento (1s) / Normal (333ms) / Rápido (100ms)

#### 8. **Estadísticas en Vivo**
- Amperaje actual
- Profundidad actual (con indicador "Peak Shaved")
- Avance (% y celdas visitadas)
- Overloads registrados
- Energía acumulada (kWh)

### Comunicación
Escribe en `localStorage` con clave `tractor_telemetry` cada vez que avanza una celda, enviando:
```javascript
{
  posicion: { x, y },
  amperaje: { actual, optimo, maximo },
  profundidad: { actual, recomendada },
  velocidad,
  ajustes_automaticos,
  kwh_ahorrados,
  historial_amperaje: [...],
  mapa_terreno: [...],
  tractor_pos: { x, y },
  historial_mapa: { "x,y": { amperaje, profundidad_usada } }
}
```

---

## Flujo de Trabajo Típico

1. **Configuración**: Abrir `/simulador` y diseñar terreno
2. **Parametrización**: Ajustar parámetros del implemento y tractor
3. **Simulación**: Iniciar simulación y observar comportamiento
4. **Monitoreo**: Abrir `/` en otra ventana/pestaña para ver dashboard del operador
5. **Análisis**: Observar alertas de peak shaving y ajustes automáticos
6. **Iteración**: Modificar parámetros y repetir

---

## Casos de Uso del Peak Shaving

### Escenario 1: Terreno con Piedras
- Tractor encuentra celda con k=110 (piedra)
- Amperaje sube a 130A (excede máximo de 120A)
- Sistema reduce profundidad de 28cm → 24cm
- Amperaje baja a 105A
- Dashboard muestra alerta al operador

### Escenario 2: Zona Inundada
- k=120 (máxima resistencia)
- Múltiples ajustes automáticos
- Profundidad puede bajar hasta 10cm mínimo
- Operador puede rechazar y asumir control manual

---

## Datos Mock Iniciales

El dashboard inicia con datos de ejemplo:
- Posición: (4, 7)
- Amperaje: 87A (óptimo: 75A, máximo: 120A)
- Profundidad: 28cm (recomendada: 24cm)
- Velocidad: 6.2 km/h
- RPM: 1800
- Batería: 72% (8.4h restantes)
- 15 ajustes automáticos realizados
- 4.2 kWh ahorrados

---

## Notas Técnicas

### Sincronización entre Componentes
- Usa `window.addEventListener('storage')` para detectar cambios
- Solo funciona entre diferentes pestañas/ventanas del mismo origen
- En misma pestaña, el simulador debe estar en `/simulador` y dashboard en `/`

### Limitaciones Conocidas
- El evento `storage` no se dispara en la misma pestaña que hace el cambio
- Simulación asume 1 celda = 1 metro de distancia
- Fórmulas son simplificaciones para propósitos demostrativos

### Mejoras Potenciales
- WebSocket real para comunicación bidireccional
- Backend para persistencia de sesiones
- Telemetría histórica y análisis
- Integración con sensores reales del tractor
- Machine Learning para predicción de terreno

---

## Identidad Visual John Deere

### Colores Principales
- Verde corporativo: `#367C2B`
- Amarillo: `#FFDE00`
- Negro: `#1A1A1A`
- Gris claro: `#F5F5F5`
- Blanco: `#FFFFFF`

### Colores de Mapa
- Verde claro (baja resistencia): `#A5D6A7`
- Amarillo suave (media): `#FFF59D`
- Rojo suave (alta): `#EF9A9A`

### Tipografía
- Font: Sans-serif (sistema)
- Headers: Bold, uppercase, tracking-wider
- Monospace para logs y datos técnicos
