// Shared board/card data — ported verbatim from the single-player client so the
// two versions stay balanced identically. Pure data + pure helpers only, no I/O.
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

// Card effects are declarative {op,...} objects instead of closures, since
// these need to run inside the server's pure engine (see gameEngine.js) and
// be trivially serializable/loggable.
const FATE_CARDS = [
  {text:"A favorable wind advances you to Departure. Collect $200.", op:'moveTo', target:0},
  {text:"Storms redirect you to Kyoto. Buy it or pay double rent.", op:'moveTo', target:35, doubleRent:true},
  {text:"Advance to the nearest Airport. Pay double rent if it's owned.", op:'advanceNearest', kind:'railroad', doubleRent:true},
  {text:"Called away on business. Go directly to the Crypt. Do not collect $200.", op:'sendToJail'},
  {text:"Your travel blog goes viral! Collect $50.", op:'collect', amount:50},
  {text:"Pay a $15 fee for lost luggage.", op:'pay', amount:15},
  {text:"You found a Return Home Free voucher. Keep it until needed.", op:'keepCard', keep:true},
  {text:"General repairs assessed: pay $25 per house, $100 per hotel you own.", op:'repairs', perHouse:25, perHotel:100},
];
const OMEN_CARDS = [
  {text:"You inherit a small estate. Collect $100.", op:'collect', amount:100},
  {text:"Property tax refund! Collect $20.", op:'collect', amount:20},
  {text:"It's your birthday! Collect $10 from every other living player.", op:'birthday'},
  {text:"Community renovation fee: pay $40.", op:'pay', amount:40},
  {text:"You win a local raffle! Collect $45.", op:'collect', amount:45},
  {text:"An old voucher falls out of a drawer: Return Home Free. Keep it until needed.", op:'keepCard', keep:true},
  {text:"Go directly to the Crypt. Do not collect $200.", op:'sendToJail'},
  {text:"Advance to Departure. Collect $200.", op:'moveTo', target:0},
];

function groupTiles(group){
  const r = [];
  BOARD.forEach((t,i)=>{ if (t.group===group) r.push(i); });
  return r;
}

module.exports = {
  GROUPS, BOARD, RAILROAD_RENTS, JAIL_TILE, GOTOJAIL_TILE, VACATION_TILE, GO_TILE,
  FATE_CARDS, OMEN_CARDS, groupTiles,
};
