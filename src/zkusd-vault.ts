import { FungibleToken } from 'mina-fungible-token';
import {
  DeployArgs,
  PublicKey,
  SmartContract,
  state,
  State,
  UInt64,
  Permissions,
  Field,
  Poseidon,
  method,
  AccountUpdate,
  Bool,
  Provable,
  Signature,
  Struct,
  UInt32,
} from 'o1js';

export const ZkUsdVaultErrors = {
  AMOUNT_ZERO: 'Transaction amount must be greater than zero',
  HEALTH_FACTOR_TOO_LOW:
    'Vault would become undercollateralized (health factor < 100). Add more collateral or reduce debt first',
  HEALTH_FACTOR_TOO_HIGH:
    'Cannot liquidate: Vault is sufficiently collateralized (health factor > 100)',
  AMOUNT_EXCEEDS_DEBT:
    'Cannot repay more than the current outstanding debt amount',
  INVALID_SECRET: 'Access denied: Invalid ownership secret provided',
  INVALID_ORACLE_SIG: 'Invalid price feed signature from oracle',
  ORACLE_EXPIRED:
    'Price feed data has expired - please use current oracle data',
  INSUFFICIENT_BALANCE: 'Requested amount exceeds the vaults zkUSD balance',
  INSUFFICIENT_COLLATERAL:
    'Requested amount exceeds the deposited collateral in the vault ',
};

export class OraclePayload extends Struct({
  price: UInt64,
  blockchainLength: UInt32,
  signature: Signature,
}) {}

export class ZkUsdVault extends SmartContract {
  @state(UInt64) collateralAmount = State<UInt64>();
  @state(UInt64) debtAmount = State<UInt64>();
  @state(Field) ownershipHash = State<Field>();
  @state(PublicKey) oraclePublicKey = State<PublicKey>();
  @state(Bool) interactionFlag = State<Bool>(Bool(false));

  static COLLATERAL_RATIO = Field.from(150);
  static COLLATERAL_RATIO_PRECISION = Field.from(100);
  static PRECISION = Field.from(1e9);
  static MIN_HEALTH_FACTOR = UInt64.from(100);

  static ORACLE_PUBLIC_KEY = PublicKey.fromBase58(
    'B62qkQA5kdAsyvizsSdZ9ztzNidsqNXj9YrESPkMwUPt1J8RYDGkjAY'
  );
  static ZKUSD_TOKEN_ADDRESS = PublicKey.fromBase58(
    'B62qry2wngUSGZqQn9erfnA9rZPn4cMbDG1XPasGdK1EtKQAxmgjDtt'
  );

  async deploy(args: DeployArgs & { secret: Field }) {
    await super.deploy(args);
    // Set permissions to prevent unauthorized updates
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey:
        Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
      editState: Permissions.proofOrSignature(),
    });

    this.collateralAmount.set(UInt64.from(0));
    this.debtAmount.set(UInt64.from(0));

    const ownershipHash = Poseidon.hash(args.secret.toFields());
    this.ownershipHash.set(ownershipHash);
  }

  @method async depositCollateral(amount: UInt64, secret: Field) {
    //Preconditions
    let collateralAmount = this.collateralAmount.getAndRequireEquals();
    this.debtAmount.getAndRequireEquals();
    let ownershipHash = this.ownershipHash.getAndRequireEquals();

    //assert amount is greater than 0
    amount.assertGreaterThan(UInt64.from(0), ZkUsdVaultErrors.AMOUNT_ZERO);

    //Assert the ownership secret is correct
    ownershipHash.assertEquals(
      Poseidon.hash(secret.toFields()),
      ZkUsdVaultErrors.INVALID_SECRET
    );

    const collateralDeposit = AccountUpdate.createSigned(
      this.sender.getAndRequireSignatureV2()
    );

    collateralDeposit.send({
      to: this.address,
      amount: amount,
    });

    this.collateralAmount.set(collateralAmount.add(amount));
  }

  @method async redeemCollateral(
    amount: UInt64,
    secret: Field,
    oraclePayload: OraclePayload
  ) {
    //Preconditions
    let collateralAmount = this.collateralAmount.getAndRequireEquals();
    let debtAmount = this.debtAmount.getAndRequireEquals();
    let ownershipHash = this.ownershipHash.getAndRequireEquals();

    //assert amount is greater than 0
    amount.assertGreaterThan(UInt64.from(0), ZkUsdVaultErrors.AMOUNT_ZERO);

    //Assert the ownership secret is correct
    ownershipHash.assertEquals(
      Poseidon.hash(secret.toFields()),
      ZkUsdVaultErrors.INVALID_SECRET
    );

    //verify the oracle price
    this.verifyOraclePayload(oraclePayload);

    //Assert the amount is less than the collateral amount
    amount.assertLessThanOrEqual(
      collateralAmount,
      ZkUsdVaultErrors.INSUFFICIENT_COLLATERAL
    );

    //Calculate the USD value of the collateral after redemption
    const remainingCollateral = collateralAmount.sub(amount);

    //Calculate the health factor
    const healthFactor = this.calculateHealthFactor(
      remainingCollateral,
      debtAmount,
      oraclePayload.price
    );

    //Assert the health factor is greater than the minimum health factor
    healthFactor.assertGreaterThanOrEqual(
      ZkUsdVault.MIN_HEALTH_FACTOR,
      ZkUsdVaultErrors.HEALTH_FACTOR_TOO_LOW
    );

    //Send the collateral back to the sender
    this.send({
      to: this.sender.getAndRequireSignatureV2(),
      amount: amount,
    });

    //Update the collateral amount
    this.collateralAmount.set(remainingCollateral);
  }

  @method async mintZkUsd(
    amount: UInt64,
    secret: Field,
    oraclePayload: OraclePayload
  ) {
    //Preconditions
    let collateralAmount = this.collateralAmount.getAndRequireEquals();
    let debtAmount = this.debtAmount.getAndRequireEquals();
    let ownershipHash = this.ownershipHash.getAndRequireEquals();

    //Assert the sender has the secret
    const zkUSD = new FungibleToken(ZkUsdVault.ZKUSD_TOKEN_ADDRESS);

    //Assert the amount is greater than 0
    amount.assertGreaterThan(UInt64.from(0), ZkUsdVaultErrors.AMOUNT_ZERO);

    //Assert the ownership secret is correct
    ownershipHash.assertEquals(
      Poseidon.hash(secret.toFields()),
      ZkUsdVaultErrors.INVALID_SECRET
    );

    //Verify the oracle price
    this.verifyOraclePayload(oraclePayload);

    const healthFactor = this.calculateHealthFactor(
      collateralAmount,
      debtAmount.add(amount), // Add the amount they want to mint to the debt
      oraclePayload.price
    );

    //Assert the health factor is greater than the minimum health factor
    healthFactor.assertGreaterThanOrEqual(
      ZkUsdVault.MIN_HEALTH_FACTOR,
      ZkUsdVaultErrors.HEALTH_FACTOR_TOO_LOW
    );

    //Mint the zkUSD
    await zkUSD.mint(this.address, amount);

    //Update the debt amount
    this.debtAmount.set(debtAmount.add(amount));

    //Set the interaction flag
    this.interactionFlag.set(Bool(true));
  }

  @method async withdrawZkUsd(amount: UInt64, secret: Field) {
    //Preconditions
    this.collateralAmount.getAndRequireEquals();
    this.debtAmount.getAndRequireEquals();
    let ownershipHash = this.ownershipHash.getAndRequireEquals();

    //Get the zkUSD token
    const zkUsd = new FungibleToken(ZkUsdVault.ZKUSD_TOKEN_ADDRESS);

    //Assert the amount is greater than 0
    amount.assertGreaterThan(UInt64.from(0), ZkUsdVaultErrors.AMOUNT_ZERO);

    //Assert the ownership secret is correct
    ownershipHash.assertEquals(
      Poseidon.hash(secret.toFields()),
      ZkUsdVaultErrors.INVALID_SECRET
    );

    //Assert the withdrawal amount is less that the balance of zkUSD
    amount.assertLessThanOrEqual(
      await zkUsd.getBalanceOf(this.address),
      ZkUsdVaultErrors.INSUFFICIENT_BALANCE
    );

    //Send the zkUSD to the sender
    await zkUsd.transfer(
      this.address,
      this.sender.getAndRequireSignatureV2(),
      amount
    );
  }

  @method async burnZkUsd(amount: UInt64, secret: Field) {
    //Preconditions
    this.collateralAmount.getAndRequireEquals();
    let debtAmount = this.debtAmount.getAndRequireEquals();
    let ownershipHash = this.ownershipHash.getAndRequireEquals();
    //Get the zkUSD token
    const zkUsd = new FungibleToken(ZkUsdVault.ZKUSD_TOKEN_ADDRESS);

    //Assert the amount is greater than 0
    amount.assertGreaterThan(UInt64.from(0), ZkUsdVaultErrors.AMOUNT_ZERO);

    //Assert the ownership secret is correct
    ownershipHash.assertEquals(
      Poseidon.hash(secret.toFields()),
      ZkUsdVaultErrors.INVALID_SECRET
    );

    //Assert the amount is less than the debt amount
    debtAmount.assertGreaterThanOrEqual(
      amount,
      ZkUsdVaultErrors.AMOUNT_EXCEEDS_DEBT
    );

    //Update the debt amount
    this.debtAmount.set(debtAmount.sub(amount));

    //Burn the zkUsd
    await zkUsd.burn(this.sender.getAndRequireSignatureV2(), amount);

    //Set the interaction flag
    this.interactionFlag.set(Bool(true));
  }

  @method async liquidate(oraclePayload: OraclePayload) {
    //Preconditions
    let collateralAmount = this.collateralAmount.getAndRequireEquals();
    let debtAmount = this.debtAmount.getAndRequireEquals();

    //Get the zkUSD token
    const zkUSD = new FungibleToken(ZkUsdVault.ZKUSD_TOKEN_ADDRESS);

    //Verify the oracle price
    this.verifyOraclePayload(oraclePayload);

    //Calculate the health factor
    const healthFactor = this.calculateHealthFactor(
      collateralAmount,
      debtAmount,
      oraclePayload.price
    );

    //Assert the health factor is less than the minimum health factor
    healthFactor.assertLessThanOrEqual(
      ZkUsdVault.MIN_HEALTH_FACTOR,
      ZkUsdVaultErrors.HEALTH_FACTOR_TOO_HIGH
    );

    //Send the collateral to the liquidator
    this.send({
      to: this.sender.getAndRequireSignatureV2(),
      amount: collateralAmount,
    });

    //Update the collateral amount
    this.collateralAmount.set(UInt64.from(0));

    //Burn the zkUSD
    await zkUSD.burn(this.sender.getUnconstrainedV2(), debtAmount);

    //Update the debt amount
    this.debtAmount.set(UInt64.from(0));

    //Set the interaction flag
    this.interactionFlag.set(Bool(true));
  }

  @method.returns(UInt64)
  async getHealthFactor(oraclePayload: OraclePayload) {
    //Verify the oracle price
    this.verifyOraclePayload(oraclePayload);

    return this.calculateHealthFactor(
      this.collateralAmount.getAndRequireEquals(),
      this.debtAmount.getAndRequireEquals(),
      oraclePayload.price
    );
  }

  // This flag is set so the zkUSD Admin contract can check its permissions
  @method.returns(Bool)
  public async assertInteractionFlag() {
    this.interactionFlag.requireEquals(Bool(true));
    this.interactionFlag.set(Bool(false));
    return Bool(true);
  }

  private verifyOraclePayload(oraclePayload: OraclePayload) {
    const validSignature = oraclePayload.signature.verify(
      ZkUsdVault.ORACLE_PUBLIC_KEY,
      [
        ...oraclePayload.price.toFields(),
        ...oraclePayload.blockchainLength.toFields(),
      ]
    );

    //Assert the signature is valid
    validSignature.assertTrue(ZkUsdVaultErrors.INVALID_ORACLE_SIG);

    //Assert the blockchain length is the same
    let length = this.network.blockchainLength.getAndRequireEquals();

    oraclePayload.blockchainLength.assertEquals(length);
  }

  private calculateUsdValue(amount: UInt64, price: UInt64): Field {
    const numCollateralValue = amount.toFields()[0].mul(price.toFields()[0]);

    return this.fieldIntegerDiv(numCollateralValue, ZkUsdVault.PRECISION);
  }

  private calculateMaxAllowedDebt(collateralValue: Field): Field {
    const numCollateralValue = collateralValue.mul(
      ZkUsdVault.COLLATERAL_RATIO_PRECISION
    );

    return this.fieldIntegerDiv(
      numCollateralValue,
      ZkUsdVault.COLLATERAL_RATIO
    );
  }

  public calculateHealthFactor(
    collateralAmount: UInt64,
    debtAmount: UInt64,
    price: UInt64
  ): UInt64 {
    const collateralValue = this.calculateUsdValue(collateralAmount, price);
    const maxAllowedDebt = this.calculateMaxAllowedDebt(collateralValue);

    // Check if debtAmount is zero to avoid division by zero
    const numerator = maxAllowedDebt.mul(ZkUsdVault.COLLATERAL_RATIO_PRECISION);
    const denominator = debtAmount.toFields()[0];

    return UInt64.fromFields([this.safeDiv(numerator, denominator)]);
  }

  private fieldIntegerDiv(x: Field, y: Field): Field {
    // Ensure y is not zero to avoid division by zero
    y.assertNotEquals(Field(0), 'Division by zero');

    // Witness the quotient q = floor(x / y)
    const q = Provable.witness(Field, () => {
      const xn = x.toBigInt();
      const yn = y.toBigInt();
      const qn = xn / yn; // Integer division
      return Field(qn);
    });

    // Compute the remainder r = x - q * y
    const r = x.sub(q.mul(y));

    // Add constraints to ensure x = q * y + r, and 0 ≤ r < y
    r.assertGreaterThanOrEqual(Field(0));
    r.assertLessThan(y);

    // Enforce the relation x = q * y + r
    x.assertEquals(q.mul(y).add(r));

    // Return the quotient q
    return q;
  }

  private safeDiv(numerator: Field, denominator: Field): Field {
    const isDenominatorZero = denominator.equals(Field(0));
    const safeDenominator = Provable.if(
      isDenominatorZero,
      Field(1),
      denominator
    );

    const divisionResult = this.fieldIntegerDiv(numerator, safeDenominator);

    return Provable.if(
      isDenominatorZero,
      UInt64.MAXINT().toFields()[0],
      divisionResult
    );
  }
}