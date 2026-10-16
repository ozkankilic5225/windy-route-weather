import type { ExternalPluginConfig } from '@windy/interfaces';
const config: ExternalPluginConfig = {
 name: 'windy-plugin-route-weather', version: '0.5.0', icon: '〰',
 title: 'Uçuş Rotası Hava Durumu', description: 'Rota üzerinde gezinerek Windy nokta tahminini inceleyin.',
 author: 'Özkan Kılıç', desktopUI: 'embedded', mobileUI: 'small',
 routerPath: '/route-weather', listenToSingleclick: true, private: true,
};
export default config;
