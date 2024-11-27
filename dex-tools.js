// File: server.js
const express = require('express');
const xrpl = require('xrpl');
const rateLimit = require('express-rate-limit');
const Decimal = require('decimal.js');
const xrpl_node = process.env.XRPL_NODE || 'wss://s1.ripple.com/'

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT_DEX_TOOLS || 3005;

function returnError(errorCode, message)
{
    return {
        "code": errorCode,
        "message": message
      }
}

function findModifiedNodesByHighLowLimit(txn, targetCurrency, targetIssuer) {
    // Validate the transaction object
    if (!txn || typeof txn !== 'object') {
        console.error("Invalid transaction object provided.");
        return [];
    }

    // Ensure that the transaction has meta and AffectedNodes
    if (!txn.meta || !Array.isArray(txn.meta.AffectedNodes)) {
        console.warn("Transaction metadata or AffectedNodes not found.");
        return [];
    }

    // Destructure AffectedNodes for easier access
    const { AffectedNodes } = txn.meta;

    // Initialize an array to hold matching FinalFields
    const matchingFinalFields = [];

    // Iterate through each node in AffectedNodes
  //  console.log(AffectedNodes)
    AffectedNodes.forEach(node => {
        // We're only interested in ModifiedNodes
        if (node.ModifiedNode && node.ModifiedNode.LedgerEntryType && node.ModifiedNode.LedgerEntryType == 'RippleState') {
            const modifiedNode = node.ModifiedNode;

            if (modifiedNode.FinalFields && modifiedNode.FinalFields.HighLimit) {
                const { HighLimit } = modifiedNode.FinalFields;

                // Compare HighLimit.currency and HighLimit.issuer with target values
                if (HighLimit.currency === targetCurrency && HighLimit.issuer === targetIssuer) {
                    // If match found, push the FinalFields to the result array
                   // console.log('found high limit')
                    matchingFinalFields.push(modifiedNode.FinalFields);
                }
            }

            if (modifiedNode.FinalFields && modifiedNode.FinalFields.LowLimit) {
                const { LowLimit } = modifiedNode.FinalFields;

                // Compare HighLimit.currency and HighLimit.issuer with target values
                if (LowLimit.currency === targetCurrency && LowLimit.issuer === targetIssuer) {
                    // If match found, push the FinalFields to the result array
                   // console.log('found low limit')
                    matchingFinalFields.push(modifiedNode.FinalFields);
                }
            }
        }
    });
   // console.log(matchingFinalFields)
    return matchingFinalFields;
}

function findAMMIDModifiedNodes(txn) {
    // Ensure that the transaction has meta and AffectedNodes
    if (!txn.meta || !Array.isArray(txn.meta.AffectedNodes)) {
        console.warn("Transaction metadata or AffectedNodes not found.");
        return [];
    }

    // Filter through AffectedNodes to find ModifiedNodes
    const modifiedNodes = txn.meta.AffectedNodes.filter(node => node.ModifiedNode);

    // Further filter to find nodes where FinalFields contain 'AMMID'
    const ammNodes = modifiedNodes.filter(node => {
        const finalFields = node.ModifiedNode.FinalFields;
        return finalFields && finalFields.AMMID;
    });

    return ammNodes;
}

function checktfNoRippleDirectEnabled(flagValue) {
    const flags = {
        tfNoRippleDirect: 65536n,
        tfPartialPayment: 131072n,
        tfLimitQuality: 262144n,
        tfFullyCanonicalSig: 2147483648n
    };
  
    const flagValueBigInt = BigInt(flagValue);
  
    let enabledFlags = [];
    let tfNoRippleDirectEnabled = false;
  
    for (const [flagName, flagVal] of Object.entries(flags)) {
        const flagValBigInt = BigInt(flagVal);
        if ((flagValueBigInt & flagValBigInt) === flagValBigInt) {
            enabledFlags.push(flagName);
        }
    }

    for(let i = 0; i < enabledFlags.length; i++) {
        if(enabledFlags[i] == 'tfNoRippleDirect') {
            tfNoRippleDirectEnabled = true;
            return tfNoRippleDirectEnabled;
        }
    }

    return tfNoRippleDirectEnabled;
}

function normalizeScientificNotation(numberStr) {
    // Check if the number is in scientific notation
    if (!/e/i.test(numberStr)) {
        // If it's already a decimal, ensure it has up to 50 decimal places
        if (numberStr.indexOf('.') === -1) {
            return numberStr;
        } else {
            // Trim to 50 decimal places and remove trailing zeros
            return numberStr
                .replace(/(\.\d{0,50})\d*/, '$1') // Limit to 50 decimal places
                .replace(/\.?0+$/, ''); // Remove trailing zeros and possible dot
        }
    }

    // Handle negative numbers
    let isNegative = false;
    if (numberStr.startsWith('-')) {
        isNegative = true;
        numberStr = numberStr.substring(1);
    }

    // Split the number into significand and exponent
    const [significand, exponent] = numberStr.toLowerCase().split('e');
    let [integerPart, fractionalPart = ''] = significand.split('.');

    const exp = parseInt(exponent, 10);

    if (exp > 0) {
        // Move decimal point to the right
        const combined = integerPart + fractionalPart;
        if (exp >= fractionalPart.length) {
            integerPart = combined.padEnd(exp + integerPart.length, '0');
            fractionalPart = '';
        } else {
            integerPart = combined.substring(0, integerPart.length + exp);
            fractionalPart = combined.substring(integerPart.length);
        }
    } else if (exp < 0) {
        // Move decimal point to the left
        const absExp = Math.abs(exp);
        const combined = integerPart + fractionalPart;
        if (absExp >= integerPart.length) {
            const zeros = '0'.repeat(absExp - integerPart.length);
            integerPart = '0';
            fractionalPart = zeros + combined;
        } else {
            integerPart = combined.substring(0, integerPart.length - absExp);
            fractionalPart = combined.substring(integerPart.length);
        }
    }

    // Combine integer and fractional parts
    let normalized = integerPart;
    if (fractionalPart.length > 0) {
        normalized += '.' + fractionalPart;
    }

    // Trim to 50 decimal places and remove trailing zeros
    if (normalized.indexOf('.') !== -1) {
        const [intPart, fracPart] = normalized.split('.');
        const trimmedFrac = fracPart.slice(0, 50).replace(/0+$/, '');
        normalized = trimmedFrac ? `${intPart}.${trimmedFrac}` : intPart;
    }

    return isNegative ? '-' + normalized : normalized;
}

// Rate limiting
// const limiter = rateLimit({
//   windowMs: 1 * 60 * 1000, // 1 minutes
//   max: 120 // limit each IP to 120 requests per min
// });
// app.use(limiter);

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

app.get('/block', async (req, res) => {
    const { number, timestamp } = req.query;
    if(number != undefined)
    {
        const client = new xrpl.Client(xrpl_node);
        try {
          await client.connect();
          const ledger = await client.request({
            command: 'ledger',
            ledger_index: number
          });
          await client.disconnect();
      
          const block = {
            block: {
              blockNumber: ledger.result.ledger_index,
              blockTimestamp: xrpl.rippleTimeToUnixTime(ledger.result.ledger.close_time) / 1000
            }
          };
      
          res.json(block);
        } catch (error) {
          console.error('Error fetching block:', error);
          res.status(500).json({ error: 'Internal server error' });
        } finally {
          if(client.isConnected)
          {
               try{
                  await client.disconnect()
              } catch(err) {}
          }
        }
    } else {
        res.status(404).json({ error: 'Block number undefined or timestamp not supported for the XRPL.' });
    }
    });

app.get('/asset', async (req, res) => {
  const { id } = req.query;
  let returnAsset = {};
  const client = new xrpl.Client(xrpl_node);
  try {
    await client.connect();

      if (id === 'XRP') {
        const xrpAsset = { asset: {
          id: 'XRP',
          name: 'XRP',
          symbol: 'XRP',
          totalSupply: '99987068281',
          circulatingSupply: '56811862950',
        }};
        returnAsset = xrpAsset
      } else {
        const [currency, issuer] = id.split('.');
        
        if (!currency || !issuer) {
            returnAsset = returnError(404, "Invalid asset ID format")
        }

        try {
          const gatewayBalances = await client.request({
            command: 'gateway_balances',
            account: issuer,
            ledger_index: "validated"
          });

          if(gatewayBalances != undefined && gatewayBalances.result.obligations != undefined)
          {
            const totalSupply = gatewayBalances.result.obligations[currency] || '0';

            const asset = { asset: {
                id: id,
                name: `${currency.length == 3 ? currency : xrpl.convertHexToString(currency).replace(/\x00/g, '')}`,
                symbol: `${currency.length == 3 ? currency : xrpl.convertHexToString(currency).replace(/\x00/g, '')}`,
                totalSupply: normalizeScientificNotation(totalSupply),
                circulatingSupply: normalizeScientificNotation(totalSupply)
            } };
            returnAsset = asset
          } else {
            console.error(`Error fetching asset ${id}:`, error);
            returnAsset = returnError(500, "Failed to fetch asset information")
          }

        } catch (error) {
          console.error(`Error fetching asset ${id}:`, error);
          returnAsset = returnError(500, "Failed to fetch asset information")
        }
      }
    
    await client.disconnect();
    res.json(returnAsset)
  } catch (error) {
    console.error('Error in asset endpoint:', error);
    res.status(500).json(returnError(500, "Internal server error"));
  } finally { 
    if(client.isConnected)
        {
             try{
                await client.disconnect()
            } catch(err) {}
        }
  }
});

app.get('/exchange', async (req, res) => {
    const { id } = req.query;
    let returnAsset = {};
    if(id != undefined)
    {
        if(id == 'xrpl_exchange')
        {
            returnAsset =  {
                exchange: {
                  factoryAddress: 'xrpl_exchange',
                  name: "XRPL",
                  logoURL: "https://ipfs.firstledger.net/ipfs/QmX7PQtC5mkodzJHytwmUiXAymCucApdHcHgFxJdJzgAmX"
                }
              }
        } else {
            returnAsset = returnError(404, "Exchange not found")
        }
        res.json(returnAsset)
    } else {
        res.status(404).json(returnError(404, "ID is undefined"));
    }
    });

app.get('/pair', async (req, res) => {
        const { id } = req.query;
      
      const client = new xrpl.Client(xrpl_node);
        try {
      
          const [base, quote] = id.split('_');
          const [baseCurrency, baseIssuer] = base.split('.');
          const [quoteCurrency, quoteIssuer] = quote.split('.');
      
          let firstTxn = undefined
          try
          {
              await client.connect();
              const accountTxn = await client.request(
                  {
                      "command": "account_tx",
                      "account": baseIssuer == 'XRP' || baseCurrency == 'XRP' ? quoteIssuer : baseIssuer,
                      "limit": 1,
                      "forward": true
                    });
      
               firstTxn = accountTxn.result.transactions[0];
          } catch(err) {}
      
          const pair = {
            pair: {
              id: id,
              asset0Id: base,
              asset1Id: quote,
              createdAtBlockNumber: firstTxn != undefined ? firstTxn.tx_json.ledger_index : 80000000,
              createdAtBlockTimestamp: firstTxn != undefined ? xrpl.rippleTimeToUnixTime(firstTxn.tx_json.date) / 1000 : 1684953531,
              createdAtTxnId: firstTxn != undefined ? firstTxn.hash : '',
              factoryAddress: 'xrpl_exchange'
            }
          };
      
         // cache.set(`pair-${id}`, pair);
          res.json(pair);
      
        } catch (error) {
          console.error('Error fetching pair:', error);
          res.status(500).json({ error: 'Internal server error' });
        } finally
        {
          if(client.isConnected)
          {
              try{
                  await client.disconnect()
              } catch(err){}
          }
        }
      });

      app.get('/events', async (req, res) => {
        const { fromBlock, toBlock } = req.query;
        const client = new xrpl.Client(xrpl_node);
        try {
          await client.connect();
      
          const blockNumbers = [];
          for (let i = Number(fromBlock); i <= Number(toBlock); i++) {
              blockNumbers.push(i);
          }
          const ledgerPromises = blockNumbers.map(blockNumber => 
              client.request({
                  command: 'ledger',
                  ledger_index: blockNumber,
                  transactions: true,
                  expand: true
              })
          );
      
          const ledgers = await Promise.all(ledgerPromises);
          
          const events = [];
      
          for (const txns of ledgers) {
      
              const i = txns.result.ledger_index
      
            for (let j = 0; j < txns.result.ledger.transactions.length; j++) {
              const t = txns.result.ledger.transactions[j];
              const txn_hash = txns.result.ledger.transactions[j].hash
              const txn_json = txns.result.ledger.transactions[j].tx_json
              const transactionIndex = t.meta.TransactionIndex
              const flags = txn_json.Flags    
              let isNoDirectRipple = false
              let ammAccount = '';
              let ammXrpBalance = '';
      
              const ammNodes = findAMMIDModifiedNodes(t)
              let numberOfAMMNodes = ammNodes != undefined ? ammNodes.length : 0;
             try{
                  if(numberOfAMMNodes == 1)
                  {
                      ammAccount = ammNodes[0].ModifiedNode.FinalFields.Account
                      ammXrpBalance = ammNodes[0].ModifiedNode.FinalFields.Balance
                  }
              } catch(err)
              {
                  numberOfAMMNodes = 0
              }
      
              if(flags != undefined)
              {
                  isNoDirectRipple = checktfNoRippleDirectEnabled(flags)
              }
      
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
                                             if(modifiedNode.FinalFields && modifiedNode.FinalFields.LowLimit && modifiedNode.FinalFields.LowLimit.issuer == txn_json.Account
                                                 && takerPays.currency == modifiedNode.FinalFields.LowLimit.currency)
                                                 {
                                                      if(modifiedNode.PreviousFields == undefined)
                                                      {
                                                          takerDiff = new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value))
                                                      } else {
                                                          takerDiff = new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value)).minus(new Decimal(Math.abs(modifiedNode.PreviousFields.Balance.value)))
                                                      }
      
                                                     if(takerDiff < 1)
                                                     {
                                                         break;
                                                     }
      
                                                     const accountRootNode = affectedNodes.filter(nodeA => {
                                                         return nodeA.ModifiedNode != undefined && nodeA.ModifiedNode.LedgerEntryType != undefined && nodeA.ModifiedNode.LedgerEntryType === "AccountRoot" && nodeA.ModifiedNode.FinalFields != undefined && nodeA.ModifiedNode.FinalFields.Account != undefined && nodeA.ModifiedNode.FinalFields.Account != undefined && nodeA.ModifiedNode.FinalFields.Account == txn_json.Account;
                                                     });
      
                                                     if(accountRootNode != undefined && accountRootNode.length > 0)
                                                     {
                                                         const acctRootNode = accountRootNode[0].ModifiedNode
      
                                                         offerExecuted = true;
                                                         type = 'Buy'
                                                         volume = new Decimal(acctRootNode.PreviousFields.Balance).minus(new Decimal(acctRootNode.FinalFields.Balance)).minus(new Decimal(txn_json.Fee))
                                                         volume = new Decimal(volume).dividedBy(1000000)
                                                         price = new Decimal(volume).dividedBy(takerDiff)
                                                         issuer = takerPays.issuer;
                                                         currency = takerPays.currency;
                                                         ticker_normalized = currency.length > 3 ? xrpl.convertHexToString(currency).replace(/\x00/g, '') : currency;
                                                         
                                                         break;
                                                     }
      
                                                 } else if (
                                                     modifiedNode.FinalFields && modifiedNode.FinalFields.HighLimit && modifiedNode.FinalFields.HighLimit.issuer == txn_json.Account
                                                     && takerPays.currency == modifiedNode.FinalFields.HighLimit.currency)
                                                     {
      
                                                          if(modifiedNode.PreviousFields == undefined)
                                                          {
                                                              takerDiff = new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value))
                                                          } else {
                                                              takerDiff = new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value)).minus(new Decimal(Math.abs(modifiedNode.PreviousFields.Balance.value)))
                                                          }
      
                                                         if(takerDiff < 1)
                                                         {
                                                             break;
                                                         }
                                                         const accountRootNode = affectedNodes.filter(nodeA => {
                                                             return nodeA.ModifiedNode != undefined && nodeA.ModifiedNode.LedgerEntryType != undefined && nodeA.ModifiedNode.LedgerEntryType === "AccountRoot" && nodeA.ModifiedNode.FinalFields != undefined && nodeA.ModifiedNode.FinalFields.Account != undefined && nodeA.ModifiedNode.FinalFields.Account == txn_json.Account;
                                                         });
      
                                                         if(accountRootNode != undefined && accountRootNode.length > 0)
                                                         {
                                                             const acctRootNode = accountRootNode[0].ModifiedNode
      
                                                             offerExecuted = true;
                                                             type = 'Buy'
                                                             volume = new Decimal(acctRootNode.PreviousFields.Balance).minus(new Decimal(acctRootNode.FinalFields.Balance)).minus(new Decimal(txn_json.Fee))
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
                                                      if(modifiedNode.PreviousFields == undefined)
                                                      {
                                                          takerDiff = new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value))
                                                      } else {
                                                          takerDiff = new Decimal(Math.abs(modifiedNode.PreviousFields.Balance.value)).minus(new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value)))
                                                      }
      
                                                     if(takerDiff <= 0)
                                                     {
                                                         break;
                                                     }
                                                     const accountRootNode = affectedNodes.filter(node => {
                                                      return node.ModifiedNode != undefined && node.ModifiedNode.LedgerEntryType != undefined && node.ModifiedNode.LedgerEntryType === "AccountRoot" && node.ModifiedNode.FinalFields != undefined && node.ModifiedNode.FinalFields.Account != undefined && node.ModifiedNode.FinalFields.Account == txn_json.Account;
                                                     });
      
                                                     if(accountRootNode != undefined && accountRootNode.length > 0)
                                                     {
                                                         const acctRootNode = accountRootNode[0].ModifiedNode
                                                         type = 'Sell'
                                                         if(acctRootNode.PreviousFields.Balance == undefined)
                                                          {
                                                           volume = txn_json.Fee
                                                          } else {
                                                           volume = new Decimal(acctRootNode.FinalFields.Balance).minus(new Decimal(acctRootNode.PreviousFields.Balance)).plus(new Decimal(txn_json.Fee))
                                                          }
      
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
                                                          if(modifiedNode.PreviousFields == undefined)
                                                          {
                                                              takerDiff = new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value))
                                                          } else {
                                                              takerDiff = new Decimal(Math.abs(modifiedNode.PreviousFields.Balance.value)).minus(new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value)))
                                                          }
      
                                                         if(takerDiff <= 0)
                                                         {
                                                                 break;
                                                         }
      
                                                         const accountRootNode = affectedNodes.filter(node => {
                                                          return node.ModifiedNode != undefined && node.ModifiedNode.LedgerEntryType != undefined && node.ModifiedNode.LedgerEntryType === "AccountRoot" && node.ModifiedNode.FinalFields != undefined && node.ModifiedNode.FinalFields.Account != undefined && node.ModifiedNode.FinalFields.Account == txn_json.Account;
                                                         });
      
                                                         if(accountRootNode != undefined && accountRootNode.length > 0)
                                                         {
                                                             const acctRootNode = accountRootNode[0].ModifiedNode
                                                             type = 'Sell'
                                                             if(acctRootNode.PreviousFields.Balance == undefined)
                                                             {
                                                               volume = txn_json.Fee
                                                             } else {
                                                               volume = new Decimal(acctRootNode.FinalFields.Balance).minus(new Decimal(acctRootNode.PreviousFields.Balance)).plus(new Decimal(txn_json.Fee))
                                                             }
      
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
                                  //Try to get AMM info, if no pool, then fallback on priceNative
                                  let reserveAsset0 = '0'
                                  let reserveAsset1 = '0'
                                  try{
                                      if(numberOfAMMNodes == 1)
                                      {
                                          const highLimitTokenBalanceNode = findModifiedNodesByHighLowLimit(t, currency, ammAccount)
                                          if(highLimitTokenBalanceNode.length == 1)
                                          {
                                              const xrpAmount = new Decimal(ammXrpBalance).dividedBy(1000000)
                                              const tokenAmount = new Decimal(Math.abs(highLimitTokenBalanceNode[0].Balance.value))
                                              price = new Decimal(xrpAmount).dividedBy(tokenAmount)
                                              reserveAsset1 = xrpAmount.toString()
                                              reserveAsset0 = tokenAmount.toString()
                                          } else {
                                             // console.log('amm hit', numberOfAMMNodes, currency, ammAccount)
                                             // console.log(txn_hash)
                                              const ammInfo = await client.request(ammInfoRequest(issuer, currency, i));
                                              if(ammInfo && ammInfo.result && ammInfo.result.amm)
                                              {
                                                  const xrpAmount = new Decimal(ammInfo.result.amm.amount).dividedBy(1000000)
                                                  const tokenAmount = new Decimal(ammInfo.result.amm.amount2.value)
                                                  price = new Decimal(xrpAmount).dividedBy(tokenAmount)
                                                  reserveAsset1 = xrpAmount.toString()
                                                  reserveAsset0 = tokenAmount.toString()
                                              } 
                                          }
                                      } else if (numberOfAMMNodes > 1) {
                                         // console.log('amm hit', numberOfAMMNodes)
                                          const ammInfo = await client.request(ammInfoRequest(issuer, currency, i));
                                          if(ammInfo && ammInfo.result && ammInfo.result.amm)
                                          {
                                              const xrpAmount = new Decimal(ammInfo.result.amm.amount).dividedBy(1000000)
                                              const tokenAmount = new Decimal(ammInfo.result.amm.amount2.value)
                                              price = new Decimal(xrpAmount).dividedBy(tokenAmount)
                                              reserveAsset1 = xrpAmount.toString()
                                              reserveAsset0 = tokenAmount.toString()
                                          } 
                                      } else {
                                          //crosses dex and not AMM (skip)
                                      }
                                  } catch(err){console.log(err)}
      
                                  events.push({
                                      block: {
                                      blockNumber: i,
                                      blockTimestamp: xrpl.rippleTimeToUnixTime(txns.result.ledger.close_time) / 1000
                                      },
                                      eventType: 'swap',
                                      txnId: txn_hash,
                                      txnIndex: transactionIndex,
                                      eventIndex: 0,
                                      maker: txn_json.Account,
                                      pairId: currency + '.' + issuer + '_XRP',
                                      asset1In: normalizeScientificNotation(volume.toString()),
                                      asset0Out: normalizeScientificNotation(takerDiff.toString()),
                                      priceNative: normalizeScientificNotation(price.toString()),
                                      reserves: {
                                      asset0: normalizeScientificNotation(reserveAsset0),
                                      asset1: normalizeScientificNotation(reserveAsset1)
                                      }
                                  });
                              } else {
      
                                  //Try to get AMM info, if no pool, then fallback on priceNative
                                  let reserveAsset0 = '0'
                                  let reserveAsset1 = '0'
                                  try{
                                      if(numberOfAMMNodes == 1)
                                      {
                                          const highLimitTokenBalanceNode = findModifiedNodesByHighLowLimit(t, currency, ammAccount)
                                          if(highLimitTokenBalanceNode.length == 1)
                                          {
                                              const xrpAmount = new Decimal(ammXrpBalance).dividedBy(1000000)
                                              const tokenAmount = new Decimal(Math.abs(highLimitTokenBalanceNode[0].Balance.value))
                                              price = new Decimal(xrpAmount).dividedBy(tokenAmount)
                                              reserveAsset1 = xrpAmount.toString()
                                              reserveAsset0 = tokenAmount.toString()
                                          } else {
                                             // console.log('amm hit', numberOfAMMNodes, currency, ammAccount)
                                           //  console.log(txn_hash)
                                              const ammInfo = await client.request(ammInfoRequest(issuer, currency, i));
                                              if(ammInfo && ammInfo.result && ammInfo.result.amm)
                                              {
                                                  const xrpAmount = new Decimal(ammInfo.result.amm.amount).dividedBy(1000000)
                                                  const tokenAmount = new Decimal(ammInfo.result.amm.amount2.value)
                                                  price = new Decimal(xrpAmount).dividedBy(tokenAmount)
                                                  reserveAsset1 = xrpAmount.toString()
                                                  reserveAsset0 = tokenAmount.toString()
                                              } 
                                          }
                                      } else if (numberOfAMMNodes > 1) {
                                          //console.log('amm hit', numberOfAMMNodes)
                                          const ammInfo = await client.request(ammInfoRequest(issuer, currency, i));
                                          if(ammInfo && ammInfo.result && ammInfo.result.amm)
                                          {
                                              const xrpAmount = new Decimal(ammInfo.result.amm.amount).dividedBy(1000000)
                                              const tokenAmount = new Decimal(ammInfo.result.amm.amount2.value)
                                              price = new Decimal(xrpAmount).dividedBy(tokenAmount)
                                              reserveAsset1 = xrpAmount.toString()
                                              reserveAsset0 = tokenAmount.toString()
                                          } 
                                      } else {
                                          //crosses dex and not AMM (skip)
                                      }
                                  } catch(err){console.log(err)}
      
                                  events.push({
                                      block: {
                                      blockNumber: i,
                                      blockTimestamp: xrpl.rippleTimeToUnixTime(txns.result.ledger.close_time) / 1000
                                      },
                                      eventType: 'swap',
                                      txnId: txn_hash,
                                      txnIndex: transactionIndex,
                                      eventIndex: 0,
                                      maker: txn_json.Account,
                                      pairId:  currency + '.' + issuer + '_XRP',
                                      asset0In: normalizeScientificNotation(takerDiff.toString()),
                                      asset1Out: normalizeScientificNotation(volume.toString()),
                                      priceNative: normalizeScientificNotation(price.toString()),
                                      reserves: {
                                      asset0: normalizeScientificNotation(reserveAsset0),
                                      asset1: normalizeScientificNotation(reserveAsset1)
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
                                              if(modifiedNode.PreviousFields == undefined)
                                              {
                                                  takerDiff = new Decimal(modifiedNode.FinalFields.Balance.value)
                                              } else {
                                                  takerDiff = new Decimal(modifiedNode.PreviousFields.Balance.value).minus(new Decimal(modifiedNode.FinalFields.Balance.value))
                                              }
                                             if(takerDiff > 0 && isNoDirectRipple == false)
                                             {
                                                  offerExecuted = true;
                                             }
                                             break;
                                         } else if (
                                             modifiedNode.FinalFields && modifiedNode.FinalFields.HighLimit && modifiedNode.FinalFields.HighLimit.issuer == txn_json.Account
                                             && txn_json.SendMax.currency == modifiedNode.FinalFields.HighLimit.currency)
                                             {
                                                 if(modifiedNode.PreviousFields == undefined)
                                                 {
                                                      takerDiff = new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value))
                                                 } else {
                                                      takerDiff = new Decimal(Math.abs(modifiedNode.PreviousFields.Balance.value)).minus(new Decimal(Math.abs(modifiedNode.FinalFields.Balance.value)))
                                                 }
                                                 if(takerDiff > 0 && isNoDirectRipple == false)
                                                 {
                                                      offerExecuted = true;
                                                 }
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
      
                                  //Try to get AMM info, if no pool, then fallback on priceNative
                                  let reserveAsset0 = '0'
                                  let reserveAsset1 = '0'
                                  try{
                                      if(numberOfAMMNodes == 1)
                                          {
                                              const highLimitTokenBalanceNode = findModifiedNodesByHighLowLimit(t, currency, ammAccount)
                                              if(highLimitTokenBalanceNode.length == 1)
                                              {
                                                  const xrpAmount = new Decimal(ammXrpBalance).dividedBy(1000000)
                                                  const tokenAmount = new Decimal(Math.abs(highLimitTokenBalanceNode[0].Balance.value))
                                                  price = new Decimal(xrpAmount).dividedBy(tokenAmount)
                                                  reserveAsset1 = xrpAmount.toString()
                                                  reserveAsset0 = tokenAmount.toString()
                                              } else {
                                                 // console.log('amm hit', numberOfAMMNodes, currency, ammAccount)
                                                 // console.log(txn_hash)
                                                  const ammInfo = await client.request(ammInfoRequest(issuer, currency, i));
                                                  if(ammInfo && ammInfo.result && ammInfo.result.amm)
                                                  {
                                                      const xrpAmount = new Decimal(ammInfo.result.amm.amount).dividedBy(1000000)
                                                      const tokenAmount = new Decimal(ammInfo.result.amm.amount2.value)
                                                      price = new Decimal(xrpAmount).dividedBy(tokenAmount)
                                                      reserveAsset1 = xrpAmount.toString()
                                                      reserveAsset0 = tokenAmount.toString()
                                                  } 
                                              }
                                          } else if (numberOfAMMNodes > 1) {
                                             // console.log('amm hit', numberOfAMMNodes)
                                              const ammInfo = await client.request(ammInfoRequest(issuer, currency, i));
                                              if(ammInfo && ammInfo.result && ammInfo.result.amm)
                                              {
                                                  const xrpAmount = new Decimal(ammInfo.result.amm.amount).dividedBy(1000000)
                                                  const tokenAmount = new Decimal(ammInfo.result.amm.amount2.value)
                                                  price = new Decimal(xrpAmount).dividedBy(tokenAmount)
                                                  reserveAsset1 = xrpAmount.toString()
                                                  reserveAsset0 = tokenAmount.toString()
                                              } 
                                          } else {
                                              //crosses dex and not AMM (skip)
                                          }
                                  } catch(err){console.log(err)}
                     
                                 events.push({
                                  block: {
                                  blockNumber: i,
                                  blockTimestamp: xrpl.rippleTimeToUnixTime(txns.result.ledger.close_time) / 1000
                                  },
                                  eventType: 'swap',
                                  txnId: txn_hash,
                                  txnIndex: transactionIndex,
                                  eventIndex: 0,
                                  maker: txn_json.Account,
                                  pairId:  currency + '.' + issuer + '_XRP',
                                  asset0In: normalizeScientificNotation(takerDiff.toString()),
                                  asset1Out: normalizeScientificNotation(volume.toString()),
                                  priceNative: normalizeScientificNotation(price.toString()),
                                  reserves: {
                                  asset0: normalizeScientificNotation(reserveAsset0), // XRPL doesn't have liquidity pools, so we can't provide this information
                                  asset1: normalizeScientificNotation(reserveAsset1)
                                  }
                              });
      
                             }
      
                         } else if (t.meta.DeliveredAmount && typeof t.meta.DeliveredAmount == 'object' && typeof txn_json.SendMax == 'string')
                         {
                            takerDiff = new Decimal(t.meta.DeliveredAmount.value)
                             //Now find the amount of token that was exchanged
                             const affectedNodes = t.meta.AffectedNodes
                             for (const node of affectedNodes) {
                                 const modifiedNode = node.ModifiedNode;
                                 if(modifiedNode && modifiedNode.LedgerEntryType == 'AccountRoot')
                                 {
                                     if(modifiedNode.FinalFields && modifiedNode.FinalFields.Account == txn_json.Account)
                                     {
                                          if(modifiedNode.PreviousFields == undefined)
                                          {
                                              volume = new Decimal(modifiedNode.FinalFields.Balance).minus(new Decimal(txn_json.Fee))
                                          } else {
                                              volume = new Decimal(modifiedNode.PreviousFields.Balance).minus(new Decimal(modifiedNode.FinalFields.Balance)).minus(new Decimal(txn_json.Fee))
                                          }
      
                                         volume = new Decimal(volume).dividedBy(1000000)
                                         //Only show executed where volume is greater than 0
                                         if(volume > 0 && isNoDirectRipple == false)
                                         {
                                              offerExecuted = true;
                                         }
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
      
                                  //Try to get AMM info, if no pool, then fallback on priceNative
                                  let reserveAsset0 = '0'
                                  let reserveAsset1 = '0'
                                  try{
                                      if(numberOfAMMNodes == 1)
                                          {
                                              const highLimitTokenBalanceNode = findModifiedNodesByHighLowLimit(t, currency, ammAccount)
                                              if(highLimitTokenBalanceNode.length == 1)
                                              {
                                                  const xrpAmount = new Decimal(ammXrpBalance).dividedBy(1000000)
                                                  const tokenAmount = new Decimal(Math.abs(highLimitTokenBalanceNode[0].Balance.value))
                                                  price = new Decimal(xrpAmount).dividedBy(tokenAmount)
                                                  reserveAsset1 = xrpAmount.toString()
                                                  reserveAsset0 = tokenAmount.toString()
                                              } else {
                                                 // console.log('amm hit', numberOfAMMNodes, currency, ammAccount)
                                                 // console.log(txn_hash)
                                                  const ammInfo = await client.request(ammInfoRequest(issuer, currency, i));
                                                  if(ammInfo && ammInfo.result && ammInfo.result.amm)
                                                  {
                                                      const xrpAmount = new Decimal(ammInfo.result.amm.amount).dividedBy(1000000)
                                                      const tokenAmount = new Decimal(ammInfo.result.amm.amount2.value)
                                                      price = new Decimal(xrpAmount).dividedBy(tokenAmount)
                                                      reserveAsset1 = xrpAmount.toString()
                                                      reserveAsset0 = tokenAmount.toString()
                                                  } 
                                              }
                                          } else if (numberOfAMMNodes > 1) {
                                              //console.log('amm hit', numberOfAMMNodes)
                                              const ammInfo = await client.request(ammInfoRequest(issuer, currency, i));
                                              if(ammInfo && ammInfo.result && ammInfo.result.amm)
                                              {
                                                  const xrpAmount = new Decimal(ammInfo.result.amm.amount).dividedBy(1000000)
                                                  const tokenAmount = new Decimal(ammInfo.result.amm.amount2.value)
                                                  price = new Decimal(xrpAmount).dividedBy(tokenAmount)
                                                  reserveAsset1 = xrpAmount.toString()
                                                  reserveAsset0 = tokenAmount.toString()
                                              } 
                                          } else {
                                              //crosses dex and not AMM (skip)
                                          }
                                  } catch(err){console.log(err)}
      
                                 events.push({
                                  block: {
                                  blockNumber: i,
                                  blockTimestamp: xrpl.rippleTimeToUnixTime(txns.result.ledger.close_time) / 1000
                                  },
                                  eventType: 'swap',
                                  txnId: txn_hash,
                                  txnIndex: transactionIndex,
                                  eventIndex: 0,
                                  maker: txn_json.Account,
                                  pairId: currency + '.' + issuer + '_XRP',
                                  asset1In: normalizeScientificNotation(volume.toString()),
                                  asset0Out: normalizeScientificNotation(takerDiff.toString()),
                                  priceNative: normalizeScientificNotation(price.toString()),
                                  reserves: {
                                  asset0: reserveAsset0, // XRPL doesn't have liquidity pools, so we can't provide this information
                                  asset1: reserveAsset1
                                  }
                              });
      
                             }
      
      
                         }
                     }
                  }
      
      
            }
          }
          res.json({ events });
        } catch (error) {
          console.error('Error fetching events:', error);
          res.status(500).json({ error: 'Internal server error' });
        } finally
        {
          if(client.isConnected)
          {
              try{
                  await client.disconnect()
              } catch(err){}
          }
        }
      });

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(port, () => {
  console.log(`XRPL DEX Adapter API listening at http://localhost:${port}`);
});