// Browser-global mirror of server/boardConfig.js — used only for rendering
// (tile names/flags/prices/rent tables). Must stay in sync with the server
// copy if the board is ever rebalanced; the server's copy is authoritative
// for gameplay, this one never drives game logic, only display.
'use strict';

const GROUPS = {
  budget:  {name:'Egypt',     flag:'🇪🇬', color:'#8a7bd6', houseCost:50,  mortgageRate:0.5},
  desert:  {name:'Morocco',   flag:'🇲🇦', color:'#e0a458', houseCost:50,  mortgageRate:0.5},
  uae:     {name:'UAE',       flag:'🇦🇪', color:'#d65f6f', houseCost:100, mortgageRate:0.5},
  monsoon: {name:'Thailand',  flag:'🇹🇭', color:'#f2c14e', houseCost:100, mortgageRate:0.5},
  bazaar:  {name:'Turkey',    flag:'🇹🇷', color:'#6fb5d6', houseCost:150, mortgageRate:0.5},
  oldworld:{name:'Spain',     flag:'🇪🇸', color:'#e0777a', houseCost:150, mortgageRate:0.5},
  southern:{name:'Australia', flag:'🇦🇺', color:'#7bd6a8', houseCost:200, mortgageRate:0.5},
  summit:  {name:'Japan',     flag:'🇯🇵', color:'#3fd6ae', houseCost:200, mortgageRate:0.5},
};

function prop(city, flag, country, group, price, rent){
  return {type:'property', name:city, country, flag, group, price, rent, mortgage: Math.round(price*0.5)};
}

const BOARD = [
  {type:'go', name:'Departure'},
  prop('Luxor','🇪🇬','Egypt','budget',60,[2,10,30,90,160,250]),
  prop('Alexandria','🇪🇬','Egypt','budget',60,[3,15,45,135,240,350]),
  prop('Cairo','🇪🇬','Egypt','budget',60,[4,20,60,180,320,450]),
  {type:'tax', name:'Customs Duty', amount:200},
  {type:'railroad', name:'Northbound Airways', price:200, mortgage:100},
  prop('Fez','🇲🇦','Morocco','desert',100,[6,30,90,270,400,550]),
  {type:'fate', name:'Fate Card'},
  prop('Marrakesh','🇲🇦','Morocco','desert',100,[6,30,90,270,400,550]),
  prop('Casablanca','🇲🇦','Morocco','desert',120,[8,40,100,300,450,600]),
  {type:'jail', name:'The Crypt'},
  prop('Abu Dhabi','🇦🇪','UAE','uae',140,[10,50,150,450,625,750]),
  {type:'utility', name:'Power Grid', price:150, mortgage:75},
  prop('Dubai','🇦🇪','UAE','uae',160,[12,60,180,500,700,900]),
  {type:'omen', name:'Omen Card'},
  {type:'railroad', name:'Eastbound Airways', price:200, mortgage:100},
  prop('Phuket','🇹🇭','Thailand','monsoon',180,[14,70,200,550,750,950]),
  {type:'omen', name:'Omen Card'},
  prop('Chiang Mai','🇹🇭','Thailand','monsoon',180,[14,70,200,550,750,950]),
  prop('Bangkok','🇹🇭','Thailand','monsoon',200,[16,80,220,600,800,1000]),
  {type:'vacation', name:'Vacation'},
  prop('Izmir','🇹🇷','Turkey','bazaar',220,[18,90,250,700,875,1050]),
  {type:'fate', name:'Fate Card'},
  prop('Ankara','🇹🇷','Turkey','bazaar',220,[18,90,250,700,875,1050]),
  prop('Istanbul','🇹🇷','Turkey','bazaar',240,[20,100,300,750,925,1100]),
  {type:'railroad', name:'Southbound Airways', price:200, mortgage:100},
  prop('Seville','🇪🇸','Spain','oldworld',260,[22,110,330,800,975,1150]),
  prop('Barcelona','🇪🇸','Spain','oldworld',260,[22,110,330,800,975,1150]),
  {type:'utility', name:'Water Supply', price:150, mortgage:75},
  prop('Madrid','🇪🇸','Spain','oldworld',280,[24,120,360,850,1025,1200]),
  {type:'gotojail', name:'Cursed Grounds'},
  prop('Brisbane','🇦🇺','Australia','southern',300,[26,130,390,900,1100,1275]),
  prop('Melbourne','🇦🇺','Australia','southern',300,[26,130,390,900,1100,1275]),
  {type:'omen', name:'Omen Card'},
  prop('Sydney','🇦🇺','Australia','southern',320,[28,150,450,1000,1200,1400]),
  {type:'railroad', name:'Westbound Airways', price:200, mortgage:100},
  {type:'fate', name:'Fate Card'},
  prop('Kyoto','🇯🇵','Japan','summit',350,[35,175,500,1100,1300,1500]),
  {type:'tax', name:'Luxury Estate Tax', amount:100},
  prop('Tokyo','🇯🇵','Japan','summit',400,[50,200,600,1400,1700,2000]),
];

const RAILROAD_RENTS = [25,50,100,200];
const JAIL_TILE=10, GOTOJAIL_TILE=30, VACATION_TILE=20, GO_TILE=0;

function groupTiles(group){
  const r = [];
  BOARD.forEach((t,i)=>{ if (t.group===group) r.push(i); });
  return r;
}
