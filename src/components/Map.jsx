import React, { useEffect, useState, useMemo } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { loadData, isServiceActive, timeToSeconds, getCurrentTimeSeconds, interpolatePositionOnShape, getNextArrival, getNextRouteTrip } from '../utils/gtfs';

const KotaBharuCenter = [6.1256, 102.2386];

export default function MapView() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    // Default to current local time
    const [currentTime, setCurrentTime] = useState(() => {
        const now = new Date();
        return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    });
    // Always playing, removed isPlaying state
    const [simSpeed, setSimSpeed] = useState(1); // 1x speed default

    useEffect(() => {
        loadData()
            .then(setData)
            .catch(err => {
                console.error("Failed to load GTFS data:", err);
                setError(err.message);
            });
    }, []);

    // Timer loop for simulation
    useEffect(() => {
        const interval = setInterval(() => {
            setCurrentTime(prev => {
                const next = prev + simSpeed;
                return next >= 86400 ? 0 : next; // Loop at midnight
            });
        }, 1000);
        return () => clearInterval(interval);
    }, [simSpeed]);

    // Simulation Engine
    const routeShapes = useMemo(() => {
        if (!data) return [];
        const shapes = [];
        const processedShapes = new Set();

        Object.keys(data.schedule).forEach(routeId => {
            const route = data.routes.find(r => r.id === routeId);
            const trips = data.schedule[routeId];
            trips.forEach(trip => {
                if (trip.shapeId && !processedShapes.has(trip.shapeId)) {
                    if (data.shapes[trip.shapeId]) {
                        shapes.push({
                            id: trip.shapeId,
                            points: data.shapes[trip.shapeId],
                            route: route
                        });
                        processedShapes.add(trip.shapeId);
                    }
                }
            });
        });
        return shapes;
    }, [data]);

    const activeTrips = useMemo(() => {
        if (!data) return [];

        const now = new Date();
        const seconds = currentTime;
        const active = [];

        Object.keys(data.schedule).forEach(routeId => {
            const routeTrips = data.schedule[routeId];
            routeTrips.forEach(trip => {
                // Check if trip runs today
                if (!isServiceActive(trip.serviceId, data.calendar, now)) return;

                const firstStop = trip.stops[0];
                const lastStop = trip.stops[trip.stops.length - 1];

                const startSec = timeToSeconds(firstStop.departure);
                const endSec = timeToSeconds(lastStop.arrival);

                if (seconds >= startSec && seconds <= endSec) {
                    let currentSegment = null;
                    for (let i = 0; i < trip.stops.length - 1; i++) {
                        const s1 = trip.stops[i];
                        const s2 = trip.stops[i + 1];
                        const t1 = timeToSeconds(s1.departure);
                        const t2 = timeToSeconds(s2.arrival);

                        if (seconds >= t1 && seconds <= t2) {
                            const progress = (seconds - t1) / (t2 - t1);
                            currentSegment = { from: s1, to: s2, progress, type: 'moving' };
                            break;
                        } else if (seconds >= timeToSeconds(s1.arrival) && seconds < t1) {
                            currentSegment = { stop: s1, type: 'dwelling' };
                            break;
                        }
                    }

                    if (currentSegment) {
                        let position = null;
                        if (currentSegment.type === 'dwelling') {
                            const stop = data.stops[currentSegment.stop.stopId];
                            if (stop) position = [stop.lat, stop.lon];
                        } else {
                            const stop1 = data.stops[currentSegment.from.stopId];
                            const stop2 = data.stops[currentSegment.to.stopId];

                            if (stop1 && stop2) {
                                // Use shape-based interpolation if shape is available
                                const shape = data.shapes[trip.shapeId];
                                position = interpolatePositionOnShape(shape, stop1, stop2, currentSegment.progress);
                            }
                        }

                        if (position) {
                            active.push({
                                ...trip,
                                route: data.routes.find(r => r.id === routeId),
                                position,
                                status: currentSegment.type
                            });
                        }
                    }
                }
            });
        });
        return active;

    }, [currentTime, data]);

    if (error) return (
        <div className="flex items-center justify-center h-screen w-full bg-red-900 text-white p-4">
            <div className="text-center">
                <h2 className="text-xl font-bold mb-2">Error Loading Data</h2>
                <p>{error}</p>
                <p className="text-sm mt-4 opacity-75">Check console for details.</p>
            </div>
        </div>
    );

    if (!data) return <div className="flex items-center justify-center h-screen w-full text-white bg-slate-900">Loading Transport Data...</div>;

    return (
        <div className="w-full h-full relative isolate">
            <div className="absolute inset-0 z-0">
                <MapContainer
                    center={KotaBharuCenter}
                    zoom={13}
                    scrollWheelZoom={true}
                    style={{ height: '100%', width: '100%' }}
                >
                    <TileLayer
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    />

                    {/* Draw Bus Stops */}
                    {data && Object.values(data.stops).map(stop => {
                        const nextBus = getNextArrival(stop.stopId, currentTime, data.stopSchedules, data.calendar);
                        // Calculate time diff in minutes
                        let minsAway = null;
                        if (nextBus) {
                            minsAway = Math.floor((nextBus.time - currentTime) / 60);
                        }

                        return (
                            <CircleMarker
                                key={stop.stopId || stop.name}
                                center={[stop.lat, stop.lon]}
                                radius={5}
                                pathOptions={{
                                    fillColor: '#ffffff',
                                    color: '#3b82f6', // Blue border
                                    weight: 2,
                                    fillOpacity: 0.9
                                }}
                            >
                                <Tooltip direction="top" offset={[0, -5]} opacity={0.95}>
                                    <div className="min-w-[120px]">
                                        <div className="font-bold text-sm border-b pb-1 mb-1 border-gray-200">{stop.name}</div>
                                        {nextBus ? (
                                            <div className="text-xs">
                                                <div className="font-semibold text-blue-600">Next Bus: {nextBus.route.shortName}</div>
                                                <div className="text-gray-600">{nextBus.headsign}</div>
                                                <div className="mt-1 font-mono bg-gray-100 px-1 rounded w-fit">
                                                    {minsAway !== null && minsAway <= 0 ? 'Due' : `${minsAway} min`}
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="text-xs text-gray-400 italic">No scheduled buses soon</div>
                                        )}
                                    </div>
                                </Tooltip>
                            </CircleMarker>
                        )
                    })}

                    {/* Draw Static Route Network */}
                    {routeShapes.map((shape, idx) => (
                        <Polyline
                            key={`shape-${shape.id}-${idx}`}
                            positions={shape.points}
                            pathOptions={{
                                color: shape.route.color,
                                weight: 3,
                                opacity: 0.6
                            }}
                        >
                            <Tooltip sticky>
                                <div className="text-xs">
                                    <span className="font-bold">{shape.route.shortName}</span>: {shape.route.longName}
                                </div>
                            </Tooltip>
                        </Polyline>
                    ))}

                    {/* Draw Active Buses */}
                    {activeTrips.map((trip, idx) => (
                        <CircleMarker
                            key={`${trip.tripId}-${idx}`}
                            center={trip.position}
                            radius={6}
                            pathOptions={{
                                fillColor: '#ef4444',
                                color: 'white',
                                weight: 2,
                                fillOpacity: 1
                            }}
                        >
                            <Popup>
                                <div className="p-1">
                                    <div className="text-sm font-bold text-gray-900">{trip.route.shortName}</div>
                                    <div className="text-xs text-gray-600 truncate max-w-[150px]">{trip.headsign}</div>
                                    <div className="text-xs mt-1 px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-800 inline-block capitalize">{trip.status}</div>
                                </div>
                            </Popup>
                        </CircleMarker>
                    ))}
                </MapContainer>
            </div>

            {/* Simulation Controls Overlay */}
            <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-slate-900 text-white p-4 rounded-xl shadow-2xl z-[9999] w-[90%] max-w-md border border-slate-700">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-mono text-blue-400">
                        {new Date(currentTime * 1000).toISOString().substr(11, 8)}
                    </span>
                    <div className="flex gap-2">
                        <button
                            onClick={() => {
                                const now = new Date();
                                setCurrentTime(now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds());
                                setSimSpeed(1); // Reset speed to normal
                            }}
                            className="px-3 py-1 rounded-md text-xs font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 transition-colors"
                        >
                            LIVE NOW
                        </button>
                        <select
                            value={simSpeed}
                            onChange={(e) => setSimSpeed(Number(e.target.value))}
                            className="bg-slate-800 border-none text-xs rounded px-2 outline-none"
                        >
                            <option value={1}>1x</option>
                            <option value={10}>10x</option>
                            <option value={60}>1m/s</option>
                            <option value={600}>10m/s</option>
                        </select>
                    </div>
                </div>
                <input
                    type="range"
                    min="0"
                    max="86400"
                    value={currentTime}
                    onChange={(e) => setCurrentTime(Number(e.target.value))}
                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <div className="flex justify-between text-[10px] text-gray-500 mt-1 font-mono">
                    <span>00:00</span>
                    <span>12:00</span>
                    <span>23:59</span>
                </div>
            </div>

            {/* Route Legend */}
            {data && data.routes && (
                <div className="fixed bottom-4 right-4 z-[9999] glass-panel p-4 rounded-xl shadow-2xl max-h-[40vh] overflow-y-auto w-[320px] border border-slate-700/50">
                    <h3 className="text-white font-bold mb-2 text-sm border-b border-gray-600 pb-1 flex justify-between items-center">
                        Route Guide
                        <span className="text-[10px] text-gray-400 font-normal">{data.routes.length} Routes</span>
                    </h3>
                    <div className="space-y-2">
                        {data.routes.map(route => (
                            <div key={route.id} className="flex items-start gap-2 text-xs hover:bg-white/5 p-1 rounded transition-colors group">
                                <div
                                    className="w-3 h-3 rounded-full shadow-sm flex-shrink-0 mt-0.5"
                                    style={{ backgroundColor: route.color }}
                                />
                                <div className="flex flex-col w-full">
                                    <div className="flex items-baseline gap-2 flex-wrap">
                                        <span className="text-gray-200 font-bold group-hover:text-white transition-colors whitespace-nowrap min-w-[30px]">
                                            {route.shortName}
                                        </span>
                                        <span className="text-gray-400 text-[10px] leading-tight group-hover:text-gray-300 transition-colors pt-0.5">
                                            {route.longName}
                                        </span>
                                    </div>
                                    {(() => {
                                        const nextTrip = getNextRouteTrip(route.id, data.schedule, data.calendar, currentTime);
                                        if (nextTrip) {
                                            return (
                                                <div className="flex items-center gap-3 mt-1 text-[10px] font-mono border-t border-white/5 pt-1 w-full text-gray-400">
                                                    <span className="flex items-center gap-1">
                                                        <span className="w-1 h-1 rounded-full bg-green-500"></span>
                                                        Dep: <span className="text-gray-200">{nextTrip.startTime}</span>
                                                    </span>
                                                    <span className="flex items-center gap-1">
                                                        <span className="w-1 h-1 rounded-full bg-blue-500"></span>
                                                        Arr: <span className="text-gray-200">{nextTrip.endTime}</span>
                                                    </span>
                                                </div>
                                            );
                                        } else {
                                            return (
                                                <div className="mt-1 text-[10px] text-gray-500 italic border-t border-white/5 pt-1">
                                                    End of Service
                                                </div>
                                            );
                                        }
                                    })()}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
