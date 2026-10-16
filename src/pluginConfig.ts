import type { ExternalPluginConfig } from '@windy/interfaces';
const config: ExternalPluginConfig = {
 name: 'windy-plugin-route-weather', version: '0.6.0', icon: '〰',
 title: 'Uçuş Rotası Hava Durumu', description: 'Rota hava tahmini, irtifa çizgisi ve canlı uçak takibi.',
 author: 'Özkan Kılıç', desktopUI: 'embedded', mobileUI: 'small',
 routerPath: '/route-weather', listenToSingleclick: true, private: true,
};
export default config;
