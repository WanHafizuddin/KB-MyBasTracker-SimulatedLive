import React from 'react';
import MapView from './components/Map';

function App() {
  return (
    <div className="relative w-full h-full">
      {/* Header / Overlay */}
      <div className="absolute top-6 left-6 z-[1000] w-auto">
        <div className="glass-panel text-white p-8 rounded-3xl shadow-2xl border border-white/10">
          <div className="flex items-center gap-4 mb-0">
            <div>
              <h1 className="text-5xl font-extrabold leading-normal bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent drop-shadow-sm pb-1">
                MyBAS Tracker
              </h1>
              <p className="text-xl text-gray-300 font-medium mt-3 tracking-wide">Kota Bharu &bull; Simulated Live</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Map */}
      <div className="w-full h-full">
        <MapView />
      </div>
    </div>
  );
}

export default App;
