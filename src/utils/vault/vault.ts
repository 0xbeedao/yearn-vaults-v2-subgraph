import { Address, ethereum, BigInt, log } from '@graphprotocol/graph-ts';
import {
  AccountVaultPosition,
  AccountVaultPositionUpdate,
  Registry,
  Strategy,
  Transaction,
  Vault,
  VaultUpdate,
} from '../../../generated/schema';

import { Vault as VaultContract } from '../../../generated/Registry/Vault';
import { Vault as VaultTemplate } from '../../../generated/templates';
import { BIGINT_ZERO, DO_CREATE_VAULT_TEMPLATE } from '../constants';
import { getOrCreateToken } from '../token';
import * as depositLibrary from '../deposit';
import * as withdrawalLibrary from '../withdrawal';
import * as accountLibrary from '../account/account';
import * as accountVaultPositionLibrary from '../account/vault-position';
import * as vaultUpdateLibrary from './vault-update';
import * as transferLibrary from '../transfer';
import * as tokenLibrary from '../token';
import * as registryLibrary from '../registry/registry';
import { updateVaultDayData } from './vault-day-data';
import { booleanToString } from '../commons';

const buildId = (vaultAddress: Address): string => {
  return vaultAddress.toHexString();
};

const createNewVaultFromAddress = (
  vaultAddress: Address,
  transaction: Transaction
): Vault => {
  let id = vaultAddress.toHexString();
  let vaultEntity = new Vault(id);
  let vaultContract = VaultContract.bind(vaultAddress);

  let token = getOrCreateToken(vaultContract.token());
  let shareToken = getOrCreateToken(vaultAddress);

  vaultEntity.transaction = transaction.id;
  vaultEntity.token = token.id;
  vaultEntity.shareToken = shareToken.id;

  // FIX: This is hardcoded, try to get from contract
  vaultEntity.classification = 'Experimental';

  // empty at creation
  vaultEntity.tags = [];
  vaultEntity.balanceTokens = BIGINT_ZERO;
  vaultEntity.balanceTokensIdle = BIGINT_ZERO;
  vaultEntity.balanceTokensInvested = BIGINT_ZERO;

  vaultEntity.tokensDepositLimit = BIGINT_ZERO;
  vaultEntity.sharesSupply = BIGINT_ZERO;
  vaultEntity.managementFeeBps = vaultContract.managementFee().toI32();
  vaultEntity.performanceFeeBps = vaultContract.performanceFee().toI32();
  vaultEntity.rewards = vaultContract.rewards();

  // vaultEntity.tokensDepositLimit = vaultContract.depositLimit()
  // vaultEntity.sharesSupply = vaultContract.totalSupply()
  // vaultEntity.managementFeeBps = vaultContract.managementFee().toI32()
  // vaultEntity.performanceFeeBps = vaultContract.performanceFee().toI32()

  // vault fields
  vaultEntity.activation = vaultContract.activation();
  vaultEntity.apiVersion = vaultContract.apiVersion();

  return vaultEntity;
};

export function getOrCreate(
  vaultAddress: Address,
  transaction: Transaction,
  createTemplate: boolean
): Vault {
  log.debug('[Vault] Get or create', []);
  let id = vaultAddress.toHexString();
  let vault = Vault.load(id);

  if (vault == null) {
    vault = createNewVaultFromAddress(vaultAddress, transaction);
    // TODO Set the registry.
    if (createTemplate) {
      VaultTemplate.create(vaultAddress);
    }
  }

  return vault;
}

export function create(
  registry: Registry,
  transaction: Transaction,
  vault: Address,
  classification: string,
  apiVersion: string,
  createTemplate: boolean
): Vault {
  log.info('[Vault] Create vault', []);
  let id = vault.toHexString();
  let vaultEntity = Vault.load(id);
  if (vaultEntity == null) {
    vaultEntity = createNewVaultFromAddress(vault, transaction);
    vaultEntity.classification = classification;
    vaultEntity.registry = registry.id;
    vaultEntity.apiVersion = apiVersion;
    vaultEntity.isTemplateListening = createTemplate;
    if (createTemplate) {
      VaultTemplate.create(vault);
    }

    log.info('NewVault {} - createTemplate? {} - IsTemplateListening? {}', [
      vault.toHexString(),
      booleanToString(createTemplate),
      booleanToString(vaultEntity.isTemplateListening),
    ]);
  } else {
    // NOTE: vault is experimental but being endorsed
    if (vaultEntity.classification !== classification) {
      vaultEntity.classification = classification;
    }
    log.info('NewVault {} - createTemplate? {} - IsTemplateListening? {}', [
      vault.toHexString(),
      booleanToString(createTemplate),
      booleanToString(vaultEntity.isTemplateListening),
    ]);
    if (!vaultEntity.isTemplateListening && createTemplate) {
      vaultEntity.isTemplateListening = true;
      VaultTemplate.create(vault);
    }
  }
  vaultEntity.save();
  return vaultEntity;
}

// TODO: implement this
export function release(
  vault: Address,
  apiVersion: string,
  releaseId: BigInt,
  event: ethereum.Event
): Vault | null {
  let id = vault.toHexString();
  let entity = Vault.load(id);
  if (entity !== null) {
    // TODO: implement this
    // entity.status = 'Released'
    // entity.apiVersion = apiVersion
    // entity.deploymentId = deploymentId
    // entity.blockNumber = event.block.number
    // entity.timestamp = getTimestampInMillis(event)
    // entity.save()
  }
  return entity;
}

export function tag(vault: Address, tag: string): Vault | null {
  let id = vault.toHexString();
  log.info('Processing tag for vault address: {}', [id]);
  let entity = Vault.load(id);
  if (entity == null) {
    log.warning("Vault DOESN'T exist for tagging: {}", [id]);
    return null;
  } else {
    entity.tags = tag.split(',');
    entity.save();
    return entity;
  }
}

export function deposit(
  vaultAddress: Address,
  transaction: Transaction,
  receiver: Address,
  depositedAmount: BigInt,
  sharesMinted: BigInt,
  timestamp: BigInt
): void {
  log.debug('[Vault] Deposit', []);
  let vaultContract = VaultContract.bind(vaultAddress);
  let account = accountLibrary.getOrCreate(receiver);
  let pricePerShare = vaultContract.pricePerShare();
  let vault = getOrCreate(vaultAddress, transaction, DO_CREATE_VAULT_TEMPLATE);

  accountVaultPositionLibrary.deposit(
    vaultContract,
    account,
    vault,
    transaction,
    depositedAmount,
    sharesMinted
  );

  depositLibrary.getOrCreate(
    account,
    vault,
    transaction,
    depositedAmount,
    sharesMinted
  );

  let vaultUpdate: VaultUpdate;
  let balancePosition = getBalancePosition(vaultContract);
  if (vault.latestUpdate == null) {
    vaultUpdate = vaultUpdateLibrary.firstDeposit(
      vault,
      transaction,
      depositedAmount,
      sharesMinted,
      pricePerShare,
      balancePosition
    );
  } else {
    vaultUpdate = vaultUpdateLibrary.deposit(
      vault,
      transaction,
      depositedAmount,
      sharesMinted,
      pricePerShare,
      balancePosition
    );
  }

  updateVaultDayData(
    vault,
    vaultContract.token(),
    timestamp,
    pricePerShare,
    depositedAmount,
    BIGINT_ZERO,
    vaultUpdate.returnsGenerated,
    vaultContract.decimals()
  );

  vault.latestUpdate = vaultUpdate.id;
  vault.balanceTokens = vault.balanceTokens.plus(depositedAmount);
  vault.balanceTokensIdle = vault.balanceTokensIdle.plus(depositedAmount);
  vault.sharesSupply = vault.sharesSupply.plus(sharesMinted);

  vault.save();
}

export function isVault(vaultAddress: Address): boolean {
  let id = buildId(vaultAddress);
  let vault = Vault.load(id);
  return vault !== null;
}

export function withdraw(
  vaultAddress: Address,
  from: Address,
  withdrawnAmount: BigInt,
  sharesBurnt: BigInt,
  transaction: Transaction,
  timestamp: BigInt
): void {
  let vaultContract = VaultContract.bind(vaultAddress);
  let pricePerShare = vaultContract.pricePerShare();
  let account = accountLibrary.getOrCreate(from);
  let balancePosition = getBalancePosition(vaultContract);
  let vault = getOrCreate(vaultAddress, transaction, DO_CREATE_VAULT_TEMPLATE);

  withdrawalLibrary.getOrCreate(
    account,
    vault,
    transaction,
    withdrawnAmount,
    sharesBurnt
  );

  // Updating Account Vault Position Update
  let accountVaultPositionId = accountVaultPositionLibrary.buildId(
    account,
    vault
  );
  let accountVaultPosition = AccountVaultPosition.load(accountVaultPositionId);
  // This scenario where accountVaultPosition === null shouldn't happen. Account vault position should have been created when the account deposited the tokens.
  if (accountVaultPosition !== null) {
    let latestAccountVaultPositionUpdate = AccountVaultPositionUpdate.load(
      accountVaultPosition.latestUpdate
    );
    // The scenario where latestAccountVaultPositionUpdate === null shouldn't happen. One account vault position update should have created when user deposited the tokens.
    if (latestAccountVaultPositionUpdate !== null) {
      accountVaultPositionLibrary.withdraw(
        vaultContract,
        accountVaultPosition as AccountVaultPosition,
        withdrawnAmount,
        sharesBurnt,
        transaction
      );
    } else {
      log.warning(
        'INVALID withdraw: Account vault position update NOT found. ID {} Vault {} TX {} from {}',
        [
          accountVaultPosition.latestUpdate,
          vaultAddress.toHexString(),
          transaction.hash.toHexString(),
          from.toHexString(),
        ]
      );
    }
  } else {
    /*
      This case should not exist because it means an user already has share tokens without having deposited before.
      BUT due to some vaults were deployed, and registered in the registry after several blocks, there are cases were some users deposited tokens before the vault were registered (in the registry).
      Example:
        Account:  0x557cde75c38b2962be3ca94dced614da774c95b0
        Vault:    0xbfa4d8aa6d8a379abfe7793399d3ddacc5bbecbb

        Vault registered at tx (block 11579536): https://etherscan.io/tx/0x6b51f1f743ec7a42db6ba1995e4ade2ba0e5b8f1fec03d3dd599a90da66d6f69

        Account transfers:
        https://etherscan.io/token/0xbfa4d8aa6d8a379abfe7793399d3ddacc5bbecbb?a=0x557cde75c38b2962be3ca94dced614da774c95b0

        The first two deposits were at blocks 11557079 and 11553285. In both cases, some blocks after registering the vault.

        As TheGraph doesn't support to process blocks before the vault was registered (using the template feature), these cases are treated as special cases (pending to fix).
    */
    if (withdrawnAmount.isZero()) {
      log.warning(
        'INVALID zero amount withdraw: Account vault position NOT found. ID {} Vault {} TX {} from {}',
        [
          accountVaultPositionId,
          vaultAddress.toHexString(),
          transaction.hash.toHexString(),
          from.toHexString(),
        ]
      );
      accountVaultPositionLibrary.withdrawZero(account, vault, transaction);
    } else {
      log.warning(
        'INVALID withdraw: Account vault position NOT found. ID {} Vault {} TX {} from {}',
        [
          accountVaultPositionId,
          vaultAddress.toHexString(),
          transaction.hash.toHexString(),
          from.toHexString(),
        ]
      );
    }
  }

  // Updating Vault Update
  if (vault.latestUpdate !== null) {
    let latestVaultUpdate = VaultUpdate.load(vault.latestUpdate!);
    // This scenario where latestVaultUpdate === null shouldn't happen. One vault update should have created when user deposited the tokens.
    if (latestVaultUpdate !== null) {
      vaultUpdateLibrary.withdraw(
        vault,
        latestVaultUpdate as VaultUpdate,
        pricePerShare,
        withdrawnAmount,
        sharesBurnt,
        transaction,
        balancePosition
      );

      updateVaultDayData(
        vault,
        vaultContract.token(),
        timestamp,
        pricePerShare,
        BIGINT_ZERO,
        withdrawnAmount,
        latestVaultUpdate.returnsGenerated,
        vaultContract.decimals()
      );
    }
  }
}

export function transfer(
  vaultContract: VaultContract,
  from: Address,
  to: Address,
  amount: BigInt,
  tokenAddress: Address,
  shareAmount: BigInt,
  vaultAddress: Address,
  transaction: Transaction
): void {
  let token = tokenLibrary.getOrCreateToken(tokenAddress);
  let shareToken = tokenLibrary.getOrCreateToken(vaultAddress);
  let fromAccount = accountLibrary.getOrCreate(from);
  let toAccount = accountLibrary.getOrCreate(to);
  let vault = getOrCreate(vaultAddress, transaction, DO_CREATE_VAULT_TEMPLATE);
  transferLibrary.getOrCreate(
    fromAccount,
    toAccount,
    vault,
    token,
    amount,
    shareToken,
    shareAmount,
    transaction
  );

  accountVaultPositionLibrary.transfer(
    vaultContract,
    fromAccount,
    toAccount,
    vault,
    amount,
    shareAmount,
    transaction
  );
}

export function strategyReported(
  transaction: Transaction,
  vaultContract: VaultContract,
  vaultAddress: Address,
  pricePerShare: BigInt
): void {
  log.info('[Vault] Strategy reported for vault {} at TX ', [
    vaultAddress.toHexString(),
    transaction.hash.toHexString(),
  ]);
  let vault = getOrCreate(vaultAddress, transaction, DO_CREATE_VAULT_TEMPLATE);
  if (vault.latestUpdate !== null) {
    let latestVaultUpdate = VaultUpdate.load(vault.latestUpdate!);

    let balancePosition = getBalancePosition(vaultContract);
    // The latest vault update should exist
    if (latestVaultUpdate !== null) {
      vaultUpdateLibrary.strategyReported(
        vault,
        latestVaultUpdate as VaultUpdate,
        transaction,
        pricePerShare,
        balancePosition
      );
    }
  }
}

export function performanceFeeUpdated(
  vaultAddress: Address,
  ethTransaction: Transaction,
  vaultContract: VaultContract,
  performanceFee: BigInt
): void {
  let vault = Vault.load(vaultAddress.toHexString());
  if (vault !== null) {
    log.info('Vault performance fee updated. Address: {}, To: {}', [
      vaultAddress.toHexString(),
      performanceFee.toString(),
    ]);

    if (vault.latestUpdate !== null) {
      let latestVaultUpdate = VaultUpdate.load(vault.latestUpdate!);

      if (latestVaultUpdate !== null) {
        let vaultUpdate = vaultUpdateLibrary.performanceFeeUpdated(
          vault as Vault,
          ethTransaction,
          latestVaultUpdate as VaultUpdate,
          getBalancePosition(vaultContract),
          performanceFee
        ) as VaultUpdate;
        vault.latestUpdate = vaultUpdate.id;
      }
    }

    vault.performanceFeeBps = performanceFee.toI32();
    vault.save();
  } else {
    log.warning('Failed to update performance fee of vault {} to {}', [
      vaultAddress.toHexString(),
      performanceFee.toString(),
    ]);
  }
}

export function managementFeeUpdated(
  vaultAddress: Address,
  ethTransaction: Transaction,
  vaultContract: VaultContract,
  managementFee: BigInt
): void {
  let vault = Vault.load(vaultAddress.toHexString());
  if (vault !== null) {
    log.info('Vault management fee updated. Address: {}, To: {}', [
      vaultAddress.toHexString(),
      managementFee.toString(),
    ]);

    if (vault.latestUpdate !== null) {
      let latestVaultUpdate = VaultUpdate.load(vault.latestUpdate!);

      if (latestVaultUpdate !== null) {
        let vaultUpdate = vaultUpdateLibrary.managementFeeUpdated(
          vault as Vault,
          ethTransaction,
          latestVaultUpdate as VaultUpdate,
          getBalancePosition(vaultContract),
          managementFee
        ) as VaultUpdate;
        vault.latestUpdate = vaultUpdate.id;
      }
    }

    vault.managementFeeBps = managementFee.toI32();
    vault.save();
  } else {
    log.warning('Failed to update management fee of vault {} to {}', [
      vaultAddress.toHexString(),
      managementFee.toString(),
    ]);
  }
}

export function strategyAddedToQueue(
  strategyAddress: Address,
  ethTransaction: Transaction,
  event: ethereum.Event
): void {
  let id = strategyAddress.toHexString();
  let txHash = ethTransaction.hash.toHexString();
  log.info('Strategy {} added to queue at tx {}', [id, txHash]);
  let strategy = Strategy.load(id);
  if (strategy !== null) {
    strategy.inQueue = true;
    strategy.save();
  }
}

export function strategyRemovedFromQueue(
  strategyAddress: Address,
  ethTransaction: Transaction,
  event: ethereum.Event
): void {
  let id = strategyAddress.toHexString();
  let txHash = ethTransaction.hash.toHexString();
  let strategy = Strategy.load(id);
  log.info('Strategy {} removed to queue at tx {}', [id, txHash]);
  if (strategy !== null) {
    strategy.inQueue = false;
    strategy.save();
  }
}

export function handleUpdateRewards(
  vaultAddress: Address,
  vaultContract: VaultContract,
  rewards: Address,
  ethTransaction: Transaction
): void {
  let vault = Vault.load(vaultAddress.toHexString());
  if (vault !== null) {
    log.info('Update vault at {} rewards address to {}', [
      vaultAddress.toHexString(),
      rewards.toHexString(),
    ]);

    if (vault.latestUpdate) {
      let latestVaultUpdate = VaultUpdate.load(vault.latestUpdate as string);

      if (latestVaultUpdate !== null) {
        log.info('Vault latest update: {}', [vault.latestUpdate as string]);
        log.info('pricePerShare: {}', [
          latestVaultUpdate.pricePerShare.toString(),
        ]);
        let vaultUpdate = vaultUpdateLibrary.rewardsUpdated(
          vault as Vault,
          ethTransaction,
          latestVaultUpdate as VaultUpdate,
          getBalancePosition(vaultContract),
          rewards
        ) as VaultUpdate;
        vault.latestUpdate = vaultUpdate.id;
      }
    }

    vault.rewards = rewards;
    vault.save();
  } else {
    log.warning('Failed to update vault at {} rewards address to {}', [
      vaultAddress.toHexString(),
      rewards.toHexString(),
    ]);
  }
}

function getBalancePosition(vaultContract: VaultContract): BigInt {
  let totalAssets = vaultContract.totalAssets();
  let tryPricePerShare = vaultContract.try_pricePerShare();
  let pricePerShare = tryPricePerShare.reverted
    ? BigInt.fromI32(0)
    : tryPricePerShare.value;
  // TODO Debugging Use pricePerShare directly
  if (tryPricePerShare.reverted) {
    log.warning('try_pricePerShare FAILED Vault {} - PricePerShare', [
      vaultContract._address.toHexString(),
      pricePerShare.toString(),
    ]);
  } else {
    log.warning('try_pricePerShare SUCCESS Vault {} - PricePerShare', [
      vaultContract._address.toHexString(),
      pricePerShare.toString(),
    ]);
  }
  // @ts-ignore
  let decimals = u8(vaultContract.decimals().toI32());
  return totalAssets.times(pricePerShare).div(BigInt.fromI32(10).pow(decimals));
}

export function createCustomVaultIfNeeded(
  vaultAddress: Address,
  registryAddress: Address,
  classification: string,
  apiVersion: string,
  transaction: Transaction,
  createTemplate: boolean
): Vault {
  let registry = registryLibrary.getOrCreate(registryAddress, transaction);
  // It is created only if it doesn't exist.
  return create(
    registry,
    transaction,
    vaultAddress,
    classification,
    apiVersion,
    createTemplate
  );
}
