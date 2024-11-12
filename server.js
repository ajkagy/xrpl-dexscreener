// File: server.js
const express = require('express');
const xrpl = require('xrpl');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const Decimal = require('decimal.js');
const xrpl_node = 'wss://s1.ripple.com/'

const app = express();
const port = process.env.PORT || 3000;

const cache = new NodeCache({ stdTTL: 3600 }); // Cache for 1 hour

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minutes
  max: 120 // limit each IP to 120 requests per min
});
app.use(limiter);

// Middleware for input validation
const validateInput = (req, res, next) => {
  const { id, fromBlock, toBlock } = req.query;
  if (req.path === '/asset' && !id) {
    return res.status(400).json({ error: 'Asset ID is required' });
  }
  if (req.path === '/events' && (!fromBlock || !toBlock)) {
    return res.status(400).json({ error: 'Both fromBlock and toBlock are required' });
  }
  next();
};

app.use(validateInput);

app.get('/latest-block', async (req, res) => {
const client = new xrpl.Client(xrpl_node);
  try {
    await client.connect();
    const ledger = await client.request({
      command: 'ledger',
      ledger_index: 'validated'
    });
    await client.disconnect();

    const block = {
      block: {
        blockNumber: ledger.result.ledger_index,
        blockTimestamp: xrpl.rippleTimeToUnixTime(ledger.result.ledger.close_time) / 1000
      }
    };

    cache.set('latest-block', block);
    res.json(block);
  } catch (error) {
    console.error('Error fetching latest block:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if(client.isConnected)
    {
         try{
            await client.disconnect()
        } catch(err) {}
    }
  }
});

app.get('/asset', async (req, res) => {
  const { id } = req.query;
  const assetIds = Array.isArray(id) ? id : id.split(',');
  const assets = [];
  const client = new xrpl.Client(xrpl_node);
  try {
    await client.connect();

    for (const assetId of assetIds) {
      const cachedAsset = cache.get(`asset-${assetId}`);
      if (cachedAsset) {
        assets.push(cachedAsset);
        continue;
      }

      if (assetId === 'XRP') {
        const xrpAsset = {
          id: 'XRP',
          name: 'XRP',
          symbol: 'XRP',
          totalSupply: '99987068281',
          circulatingSupply: '56811862950',
          coinGeckoId: 'ripple',
          coinMarketCapId: 'xrp'
        };
        assets.push(xrpAsset);
        cache.set(`asset-${assetId}`, xrpAsset);
      } else {
        const [currency, issuer] = assetId.split('.');
        
        if (!currency || !issuer) {
          assets.push({ id: assetId, error: 'Invalid asset ID format' });
          continue;
        }

        try {
          const accountInfo = await client.request({
            command: 'account_info',
            account: issuer
          });

          const gatewayBalances = await client.request({
            command: 'gateway_balances',
            account: issuer,
            ledger_index: "validated"
          });

          if(gatewayBalances != undefined && gatewayBalances.result.obligations != undefined)
          {
            const totalSupply = gatewayBalances.result.obligations[currency] || '0';

            const asset = {
              id: assetId,
              name: `${currency} (${issuer.slice(0, 8)}...)`,
              symbol: `${currency.length == 3 ? currency : xrpl.convertHexToString(currency).replace(/\x00/g, '')}`,
              totalSupply: totalSupply,
              circulatingSupply: totalSupply,
              metadata: {
                issuer: issuer,
                domain: accountInfo.result.account_data.Domain 
                  ? Buffer.from(accountInfo.result.account_data.Domain, 'hex').toString('utf-8') 
                  : undefined
              }
            };
            assets.push(asset);
            cache.set(`asset-${assetId}`, asset);
          } else {
            console.error(`Error fetching asset ${assetId}:`, error);
            assets.push({ id: assetId, error: 'Failed to fetch asset information' });
          }

        } catch (error) {
          console.error(`Error fetching asset ${assetId}:`, error);
          assets.push({ id: assetId, error: 'Failed to fetch asset information' });
        }
      }
    }

    await client.disconnect();

    res.json({ assets });
  } catch (error) {
    console.error('Error in asset endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally { 
    if(client.isConnected)
        {
             try{
                await client.disconnect()
            } catch(err) {}
        }
  }
});

app.get('/pair', async (req, res) => {
  const { id } = req.query;

  const cachedPair = cache.get(`pair-${id}`);
  if (cachedPair) {
    return res.json(cachedPair);
  }

  try {
    const client = new xrpl.Client('wss://s1.ripple.com/');
    await client.connect();

    const [base, quote] = id.split('_');
    const [baseCurrency, baseIssuer] = base.split('.');
    const [quoteCurrency, quoteIssuer] = quote.split('.');

    console.log(baseIssuer, baseCurrency)
    console.log(quoteCurrency, quoteIssuer)

    // Fetch order book to get the first trade
    console.log({
        "command": "account_tx",
        "account": baseIssuer == 'XRP' || baseCurrency == 'XRP' ? quoteIssuer : baseIssuer,
        "ledger_index_min": 32570,
        "limit": 1,
        "forward": true
      })
    const accountTxn = await client.request(
        {
            "command": "account_tx",
            "account": baseIssuer == 'XRP' || baseCurrency == 'XRP' ? quoteIssuer : baseIssuer,
            "ledger_index_min": 32570,
            "limit": 1,
            "forward": true
          });


          if(accountTxn.result.transactions.length < 1)
          {
            return res.status(404).json({ error: 'Pair not found' });
          } 

        const firstTxn = accountTxn.result.transactions[0];
        console.log(firstTxn)

    if (!firstTxn) {
      return res.status(404).json({ error: 'Pair not found' });
    }

    const pair = {
      pair: {
        id: id,
        dexKey: 'xrpl',
        asset0Id: base,
        asset1Id: quote,
        feeBps: 10, // Standard XRPL DEX fee
        createdAtBlockNumber: firstTxn.tx_json.ledger_index,
        createdAtBlockTimestamp: xrpl.rippleTimeToUnixTime(firstTxn.tx_json.date) / 1000
      }
    };

    cache.set(`pair-${id}`, pair);
    res.json(pair);

    await client.disconnect();
  } catch (error) {
    console.error('Error fetching pair:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/events', async (req, res) => {
  const { fromBlock, toBlock } = req.query;
  const client = new xrpl.Client(xrpl_node);
  try {
    await client.connect();
    
    const events = [];

    for (let i = Number(fromBlock); i <= Number(toBlock); i++) {
      const txns = await client.request({
        command: 'ledger',
        ledger_index: i,
        transactions: true,
        expand: true
      });

      for (let j = 0; j < txns.result.ledger.transactions.length; j++) {
        const t = txns.result.ledger.transactions[j];
        const txn_hash = txns.result.ledger.transactions[j].hash
        const txn_json = txns.result.ledger.transactions[j].tx_json

        if(t.meta.TransactionResult == 'tesSUCCESS' && txn_json.TransactionType == 'OfferCreate')
            {
                   const affectedNodes = t.meta.AffectedNodes
                   let offerExecuted = false;
                   let volume;
                   let price;
                   let issuer = '';
                   let currency = '';
                   let takerDiff;
                   let type = '';
                       for (const node of affectedNodes) {
                           // Look for ModifiedNode or DeletedNode related to an Offer
                           const modifiedNode = node.ModifiedNode;

                           if(modifiedNode && modifiedNode.LedgerEntryType == 'RippleState')
                               {
                                   const takerGets = txn_json.TakerGets;
                                   const takerPays = txn_json.TakerPays;

                                   if(typeof takerPays == 'object' && typeof takerGets == 'string')
                                   {
                                       if(modifiedNode.FinalFields && modifiedNode.FinalFields.LowLimit && modifiedNode.FinalFields.LowLimit.issuer == t.Account
                                           && takerPays.currency == modifiedNode.FinalFields.LowLimit.currency)
                                           {
                                               takerDiff = new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value)).minus(new Decimal(Math.abs(modifiedNode.PreviousFields.Balance.value)))

                                               if(takerDiff < 1)
                                               {
                                                   break;
                                               }

                                               const accountRootNode = affectedNodes.filter(node => {
                                                   return node.ModifiedNode != undefined && node.ModifiedNode.LedgerEntryType != undefined && node.ModifiedNode.LedgerEntryType === "AccountRoot" && node.ModifiedNode.FinalFields.Account == t.Account;
                                               });


                                               if(accountRootNode != undefined && accountRootNode.length > 0)
                                               {
                                                   const acctRootNode = accountRootNode[0].ModifiedNode

                                                   offerExecuted = true;
                                                   type = 'Buy'
                                                   volume = new Decimal(acctRootNode.PreviousFields.Balance).minus(new Decimal(acctRootNode.FinalFields.Balance)).minus(new Decimal(t.Fee))
                                                   volume = new Decimal(volume).dividedBy(1000000)
                                                   price = new Decimal(volume).dividedBy(takerDiff)
                                                   issuer = takerPays.issuer;
                                                   currency = takerPays.currency;
                                                   ticker_normalized = currency.length > 3 ? xrpl.convertHexToString(currency).replace(/\x00/g, '') : currency;
                                                   
                                                   break;
                                               }

                                           } else if (
                                               modifiedNode.FinalFields && modifiedNode.FinalFields.HighLimit && modifiedNode.FinalFields.HighLimit.issuer == t.Account
                                               && takerPays.currency == modifiedNode.FinalFields.HighLimit.currency)
                                               {
                                                   takerDiff = new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value)).minus(new Decimal(Math.abs(modifiedNode.PreviousFields.Balance.value)))
                                                  // console.log('taker diff', takerDiff)
                                                   if(takerDiff < 1)
                                                   {
                                                       break;
                                                   }

                                                   const accountRootNode = affectedNodes.filter(node => {
                                                       return node.ModifiedNode != undefined && node.ModifiedNode.LedgerEntryType != undefined && node.ModifiedNode.LedgerEntryType === "AccountRoot" && node.ModifiedNode.FinalFields.Account == t.Account;
                                                   });

                                                   if(accountRootNode != undefined && accountRootNode.length > 0)
                                                   {
                                                       const acctRootNode = accountRootNode[0].ModifiedNode
                                                      // console.log(acctRootNode.PreviousFields.Balance,acctRootNode.FinalFields.Balance )
                                                       offerExecuted = true;
                                                       type = 'Buy'
                                                       volume = new Decimal(acctRootNode.PreviousFields.Balance).minus(new Decimal(acctRootNode.FinalFields.Balance)).minus(new Decimal(t.Fee))
                                                       volume = new Decimal(volume).dividedBy(1000000)
                                                       price = new Decimal(volume).dividedBy(takerDiff)
                                                       issuer = takerPays.issuer;
                                                       currency = takerPays.currency;
                                                       ticker_normalized = currency.length > 3 ? xrpl.convertHexToString(currency).replace(/\x00/g, '') : currency;
                                                       break;
                                                   }
                                               }
                                   } else if (typeof takerPays == 'string' && typeof takerGets == 'object')
                                   {
                                       if(modifiedNode.FinalFields && modifiedNode.FinalFields.LowLimit && modifiedNode.FinalFields.LowLimit.issuer == txn_json.Account
                                           && takerGets.currency == modifiedNode.FinalFields.LowLimit.currency)
                                           {
                                               takerDiff = new Decimal(Math.abs(modifiedNode.PreviousFields.Balance.value)).minus(new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value)))
                                               if(takerDiff <= 0)
                                               {
                                                   break;
                                               }

                                               const accountRootNode = affectedNodes.filter(node => {
                                                   return node.ModifiedNode != undefined && node.ModifiedNode.LedgerEntryType != undefined && node.ModifiedNode.LedgerEntryType === "AccountRoot" && node.ModifiedNode.FinalFields.Account == txn_json.Account;
                                               });

                                               if(accountRootNode != undefined && accountRootNode.length > 0)
                                               {
                                                   const acctRootNode = accountRootNode[0].ModifiedNode
                                                   type = 'Sell'
                                                   volume = new Decimal(acctRootNode.FinalFields.Balance).minus(new Decimal(acctRootNode.PreviousFields.Balance)).plus(new Decimal(txn_json.Fee))
                                                  // console.log(volume)
                                                   if(volume < 1){break;}
                                                   volume = new Decimal(volume).dividedBy(1000000)
                                                   price = new Decimal(volume).dividedBy(takerDiff)
                                                   issuer = takerGets.issuer;
                                                   currency = takerGets.currency;
                                                   ticker_normalized = currency.length > 3 ? xrpl.convertHexToString(currency).replace(/\x00/g, '') : currency;
                                                   offerExecuted = true;
                                                   break;
                                               }

                                           } else if (
                                               modifiedNode.FinalFields && modifiedNode.FinalFields.HighLimit && modifiedNode.FinalFields.HighLimit.issuer == txn_json.Account
                                               && takerGets.currency == modifiedNode.FinalFields.HighLimit.currency)
                                               {
                                                   takerDiff = new Decimal(Math.abs(modifiedNode.PreviousFields.Balance.value)).minus(new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value)))

                                                   if(takerDiff <= 0)
                                                   {
                                                           break;
                                                   }

                                                   const accountRootNode = affectedNodes.filter(node => {
                                                       return node.ModifiedNode != undefined && node.ModifiedNode.LedgerEntryType != undefined && node.ModifiedNode.LedgerEntryType === "AccountRoot" && node.ModifiedNode.FinalFields.Account == txn_json.Account;
                                                   });

                                                   if(accountRootNode != undefined && accountRootNode.length > 0)
                                                   {
                                                       const acctRootNode = accountRootNode[0].ModifiedNode
                                                       type = 'Sell'
                                                       volume = new Decimal(acctRootNode.FinalFields.Balance).minus(new Decimal(acctRootNode.PreviousFields.Balance)).plus(new Decimal(txn_json.Fee))

                                                       if(volume < 1){break;}
                                                       volume = new Decimal(volume).dividedBy(1000000)
                                                       price = new Decimal(volume).dividedBy(takerDiff)
                                                       issuer = takerGets.issuer;
                                                       currency = takerGets.currency;
                                                       ticker_normalized = currency.length > 3 ? xrpl.convertHexToString(currency).replace(/\x00/g, '') : currency;
                                                       offerExecuted = true;
                                                       break;
                                                   }
                                               }
                                   }
                               }
                         }
                   
               
                   if (offerExecuted) {
                        if(type == 'Buy')
                        {
                            events.push({
                                block: {
                                blockNumber: i,
                                blockTimestamp: xrpl.rippleTimeToUnixTime(txns.result.ledger.close_time) / 1000
                                },
                                eventType: 'swap',
                                txnId: txn_hash,
                                txnIndex: j,
                                eventIndex: 0,
                                maker: txn_json.Account,
                                pairId: 'XRP_' + currency + '.' + issuer,
                                asset0In: volume.toString(),
                                asset1Out: takerDiff.toString(),
                                priceNative: price.toString(),
                                reserves: {
                                asset0: '0', // XRPL doesn't have liquidity pools, so we can't provide this information
                                asset1: '0'
                                }
                            });
                        } else {
                            events.push({
                                block: {
                                blockNumber: i,
                                blockTimestamp: xrpl.rippleTimeToUnixTime(txns.result.ledger.close_time) / 1000
                                },
                                eventType: 'swap',
                                txnId: txn_hash,
                                txnIndex: j,
                                eventIndex: 0,
                                maker: txn_json.Account,
                                pairId:  currency + '.' + issuer + '_XRP',
                                asset0In: takerDiff.toString(),
                                asset1Out: volume.toString(),
                                priceNative: price.toString(),
                                reserves: {
                                asset0: '0', // XRPL doesn't have liquidity pools, so we can't provide this information
                                asset1: '0'
                                }
                            });
                        }
                   }
            }

            if(txn_json.TransactionType == 'Payment' && t.meta.TransactionResult == 'tesSUCCESS')
            {

               let offerExecuted = false;
               let volume;
               let price;
               let issuer = '';
               let currency = '';
               let takerDiff;

               if(txn_json.Account == txn_json.Destination)
               {
                   if(t.meta.DeliveredAmount && typeof t.meta.DeliveredAmount == 'string' && typeof txn_json.SendMax == 'object')
                   {
                       volume = new Decimal(t.meta.DeliveredAmount).dividedBy(1000000);
                       //Now find the amount of token that was exchanged
                       const affectedNodes = t.meta.AffectedNodes
                       for (const node of affectedNodes) {
                           const modifiedNode = node.ModifiedNode;
                           if(modifiedNode && modifiedNode.LedgerEntryType == 'RippleState')
                           {
                               if(modifiedNode.FinalFields && modifiedNode.FinalFields.LowLimit && modifiedNode.FinalFields.LowLimit.issuer == txn_json.Account
                                   && txn_json.SendMax.currency == modifiedNode.FinalFields.LowLimit.currency)
                                   {
                                       offerExecuted = true;
                                       takerDiff = new Decimal(modifiedNode.PreviousFields.Balance.value).minus(new Decimal(modifiedNode.FinalFields.Balance.value))
                                       break;
                                   } else if (
                                       modifiedNode.FinalFields && modifiedNode.FinalFields.HighLimit && modifiedNode.FinalFields.HighLimit.issuer == txn_json.Account
                                       && txn_json.SendMax.currency == modifiedNode.FinalFields.HighLimit.currency)
                                       {
                                           offerExecuted = true;
                                           takerDiff = new Decimal(Math.abs(modifiedNode.PreviousFields.Balance.value)).minus(new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value)))
                                           break;
                                       }
                           }
                       }
                       if(offerExecuted == true)
                       {
                           type = 'Sell'
                           price = new Decimal(volume).dividedBy(takerDiff)
                           issuer = txn_json.SendMax.issuer;
                           currency = txn_json.SendMax.currency;
                           ticker_normalized = currency.length > 3 ? xrpl.convertHexToString(currency).replace(/\x00/g, '') : currency;
               
                           events.push({
                            block: {
                            blockNumber: i,
                            blockTimestamp: xrpl.rippleTimeToUnixTime(txns.result.ledger.close_time) / 1000
                            },
                            eventType: 'swap',
                            txnId: txn_hash,
                            txnIndex: j,
                            eventIndex: 0,
                            maker: txn_json.Account,
                            pairId:  currency + '.' + issuer + '_XRP',
                            asset0In: takerDiff.toString(),
                            asset1Out: volume.toString(),
                            priceNative: price.toString(),
                            reserves: {
                            asset0: '0', // XRPL doesn't have liquidity pools, so we can't provide this information
                            asset1: '0'
                            }
                        });

                       }

                   } else if (t.meta.DeliveredAmount && typeof t.meta.DeliveredAmount == 'object' && typeof txn_json.SendMax == 'string')
                   {
                      offerExecuted = true;
                      takerDiff = new Decimal(t.meta.DeliveredAmount.value)
                       //Now find the amount of token that was exchanged
                       const affectedNodes = t.meta.AffectedNodes
                       for (const node of affectedNodes) {
                           const modifiedNode = node.ModifiedNode;
                           if(modifiedNode && modifiedNode.LedgerEntryType == 'AccountRoot')
                           {
                               if(modifiedNode.FinalFields && modifiedNode.FinalFields.Account == txn_json.Account)
                               {
                                   offerExecuted = true;
                                   volume = new Decimal(modifiedNode.PreviousFields.Balance).minus(new Decimal(modifiedNode.FinalFields.Balance)).minus(new Decimal(txn_json.Fee))
                                   volume = new Decimal(volume).dividedBy(1000000)
                                   break;
                               }
                           }
                       }
                       if(offerExecuted == true)
                       {
                           type = 'Buy'
                           price = new Decimal(volume).dividedBy(takerDiff)
                           issuer = t.meta.DeliveredAmount.issuer;
                           currency = t.meta.DeliveredAmount.currency;
                           ticker_normalized = currency.length > 3 ? xrpl.convertHexToString(currency).replace(/\x00/g, '') : currency;

                           events.push({
                            block: {
                            blockNumber: i,
                            blockTimestamp: xrpl.rippleTimeToUnixTime(txns.result.ledger.close_time) / 1000
                            },
                            eventType: 'swap',
                            txnId: txn_hash,
                            txnIndex: j,
                            eventIndex: 0,
                            maker: txn_json.Account,
                            pairId: 'XRP_' + currency + '.' + issuer,
                            asset0In: volume.toString(),
                            asset1Out: takerDiff.toString(),
                            priceNative: price.toString(),
                            reserves: {
                            asset0: '0', // XRPL doesn't have liquidity pools, so we can't provide this information
                            asset1: '0'
                            }
                        });

                       }


                   }
               }
            }


      }
    }

    await client.disconnect();

    res.json({ events });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(port, () => {
  console.log(`XRPL DEX Adapter API listening at http://localhost:${port}`);
});