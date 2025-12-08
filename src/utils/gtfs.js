// Loaders
export async function loadData() {
    const [routes, stops, shapes, schedule, calendar] = await Promise.all([
        fetch('/data/routes.json').then(r => r.json()),
        fetch('/data/stops.json').then(r => r.json()),
        fetch('/data/shapes.json').then(r => r.json()),
        fetch('/data/schedule.json').then(r => r.json()),
        fetch('/data/calendar.json').then(r => r.json()),
    ]);

    // Enhance routes with distinct colors
    const coloredRoutes = assignRouteColors(routes);

    // Pre-calculate schedules for each stop
    const stopSchedules = precalculateStopSchedules(schedule, coloredRoutes, calendar);

    return { routes: coloredRoutes, stops, shapes, schedule, calendar, stopSchedules };
}

// Helper: Build a map of stopId -> sorted array of arrivals
function precalculateStopSchedules(schedule, routes, calendar) {
    const stopSchedules = {};

    Object.keys(schedule).forEach(routeId => {
        const route = routes.find(r => r.id === routeId);
        if (!route) return;

        schedule[routeId].forEach(trip => {
            // We include all trips for now, filtering by active day happens at runtime lookup usually, 
            // but to optimize "next bus" we might want to filter by serviceId later.
            // For static view, we'll store all and filter in getNextArrival.
            trip.stops.forEach(stop => {
                if (!stopSchedules[stop.stopId]) {
                    stopSchedules[stop.stopId] = [];
                }
                stopSchedules[stop.stopId].push({
                    time: timeToSeconds(stop.departure),
                    route: route,
                    tripId: trip.tripId,
                    serviceId: trip.serviceId,
                    headsign: trip.headsign
                });
            });
        });
    });

    // Sort arrivals by time for each stop
    Object.values(stopSchedules).forEach(arrivals => {
        arrivals.sort((a, b) => a.time - b.time);
    });

    return stopSchedules;
}

// Helper: Get next arrival for a stop
export function getNextArrival(stopId, currentTime, stopSchedules, calendar) {
    const arrivals = stopSchedules[stopId];
    if (!arrivals) return null;

    const now = new Date(); // Need actual date for service check, strictly we should use simulation date but "today" is implied

    // Find first arrival after currentTime that is active today
    // Linear search is fine here as stops don't have thousands of daily trips
    const next = arrivals.find(arrival => {
        return arrival.time > currentTime && isServiceActive(arrival.serviceId, calendar, now);
    });

    return next;
}
// Helper: Get next scheduled trip for a route
export function getNextRouteTrip(routeId, schedule, calendar, currentTime) {
    const routeTrips = schedule[routeId];
    if (!routeTrips) return null;

    const now = new Date();

    // Filter active trips
    const activeTrips = routeTrips.filter(trip => isServiceActive(trip.serviceId, calendar, now));

    // Sort by departure time of the first stop
    activeTrips.sort((a, b) => {
        const t1 = timeToSeconds(a.stops[0].departure);
        const t2 = timeToSeconds(b.stops[0].departure);
        return t1 - t2;
    });

    // Find first trip after currentTime
    const nextTrip = activeTrips.find(trip => {
        const startTime = timeToSeconds(trip.stops[0].departure);
        return startTime > currentTime;
    });

    if (!nextTrip) return null;

    const firstStop = nextTrip.stops[0];
    const lastStop = nextTrip.stops[nextTrip.stops.length - 1];

    return {
        tripId: nextTrip.tripId,
        serviceId: nextTrip.serviceId,
        startTime: firstStop.departure.substring(0, 5), // "HH:MM"
        endTime: lastStop.arrival.substring(0, 5),      // "HH:MM"
        headsign: nextTrip.headsign
    };
}


// Helper: Assign distinct colors to routes
function assignRouteColors(routes) {
    const palette = [
        '#FF3B30', // Red
        '#007AFF', // Blue
        '#34C759', // Green
        '#FF9500', // Orange
        '#AF52DE', // Purple
        '#5AC8FA', // Cyan
        '#FF2D55', // Pink
        '#5856D6', // Indigo
        '#FFCC00', // Yellow
        '#8E8E93', // Gray
    ];

    return routes.map((route, index) => ({
        ...route,
        color: palette[index % palette.length]
    }));
}

// Helper to check if a service is active today
export function isServiceActive(serviceId, calendar, date) {
    const service = calendar[serviceId];
    if (!service) return false;

    // Check date range
    const nowStr = date.toISOString().split('T')[0].replace(/-/g, '');
    if (nowStr < service.startDate || nowStr > service.endDate) return false;

    // Check day of week
    const day = date.getDay(); // 0 = Sunday
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return service[days[day]];
}

// Convert "HH:mm:ss" to seconds from midnight
export function timeToSeconds(timeStr) {
    const [h, m, s] = timeStr.split(':').map(Number);
    return h * 3600 + m * 60 + s;
}

// Get current time in seconds
export function getCurrentTimeSeconds() {
    const now = new Date();
    return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}


// Interpolate position along the actual shape path
// 1. Snap start/end stops to indices on the shape
// 2. Calculate partial distance based on progress
// 3. Walk the shape segments to find the exact point
export function interpolatePositionOnShape(shape, stopFrom, stopTo, progress) {
    if (!shape || shape.length < 2) return [stopFrom.lat, stopFrom.lon];

    // Cache these indices if performance becomes an issue
    // For now, finding closest point on each frame/segment change is okay for valid fleet sizes
    // For now, finding closest point on each frame/segment change is okay for valid fleet sizes
    const idx1 = findClosestPointIndex(shape, stopFrom, 0);
    let idx2 = findClosestPointIndex(shape, stopTo, idx1);

    // Ensure directionality (idx2 should be after idx1)
    // If we can't find a good point after idx1, it likely means idx1 was a later loop point
    // or the shape is weird. But usually simply searching forward works.
    if (idx2 < idx1) {
        // Fallback: try to find idx2 globally, maybe idx1 was wrong?
        // But for now, let's just clamp to avoid backward movement.
        idx2 = idx1;
    }

    // Extract the sub-segment of the shape
    const path = shape.slice(idx1, idx2 + 1);

    // If path is too short (just one point), return that point
    if (path.length < 2) return [stopFrom.lat, stopFrom.lon];

    // Calculate total distance of this path segment
    const distances = [];
    let totalDist = 0;
    for (let i = 0; i < path.length - 1; i++) {
        const d = haversineDistance(path[i], path[i + 1]);
        distances.push(d);
        totalDist += d;
    }

    // Target distance to travel
    let targetDist = totalDist * progress;

    // Walk the segments to find where we are
    let currentDist = 0;
    for (let i = 0; i < distances.length; i++) {
        const d = distances[i];
        if (currentDist + d >= targetDist) {
            // We are in this segment
            const segmentProgress = (targetDist - currentDist) / d;
            const p1 = path[i];
            const p2 = path[i + 1];

            const lat = p1[0] + (p2[0] - p1[0]) * segmentProgress;
            const lon = p1[1] + (p2[1] - p1[1]) * segmentProgress;
            return [lat, lon];
        }
        currentDist += d;
    }

    // Fallback to last point
    return [path[path.length - 1][0], path[path.length - 1][1]];
}

// Helper: Find index of closest shape point to a stop
function findClosestPointIndex(shape, stop, startIndex = 0) {
    let minDesc = Infinity;
    let idx = -1;

    for (let i = startIndex; i < shape.length; i++) {
        // fast euclidean squared for comparison
        const d = (shape[i][0] - stop.lat) ** 2 + (shape[i][1] - stop.lon) ** 2;
        if (d < minDesc) {
            minDesc = d;
            idx = i;
        }
    }
    return idx;
}

// Helper: Distance in meters (approx)
function haversineDistance(p1, p2) {
    const R = 6371e3; // metres
    const φ1 = p1[0] * Math.PI / 180; // φ, λ in radians
    const φ2 = p2[0] * Math.PI / 180;
    const Δφ = (p2[0] - p1[0]) * Math.PI / 180;
    const Δλ = (p2[1] - p1[1]) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

