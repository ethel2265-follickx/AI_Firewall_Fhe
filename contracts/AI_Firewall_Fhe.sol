pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract AIFirewallFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds = 30;
    bool public paused;

    struct Batch {
        uint256 id;
        bool active;
        uint256 transactionCount;
        euint32 encryptedTotalValue;
        euint32 encryptedMaxValue;
        euint32 encryptedMinValue;
        euint32 encryptedSuspiciousCount;
    }

    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsUpdated(uint256 indexed previousCooldown, uint256 indexed newCooldown);
    event PausedContract(address indexed account);
    event UnpausedContract(address indexed account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId, uint256 transactionCount);
    event TransactionAnalyzed(uint256 indexed batchId, uint256 transactionCount);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalValue, uint256 maxValue, uint256 minValue, uint256 suspiciousCount);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatch();
    error BatchNotActive();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 previousCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsUpdated(previousCooldown, newCooldownSeconds);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit PausedContract(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert Paused();
        paused = false;
        emit UnpausedContract(msg.sender);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batches[currentBatchId].active) revert BatchNotActive();
        currentBatchId++;
        Batch storage newBatch = batches[currentBatchId];
        newBatch.id = currentBatchId;
        newBatch.active = true;
        newBatch.transactionCount = 0;
        newBatch.encryptedTotalValue = FHE.asEuint32(0);
        newBatch.encryptedMaxValue = FHE.asEuint32(0);
        newBatch.encryptedMinValue = FHE.asEuint32(2**32 - 1); // Max uint32
        newBatch.encryptedSuspiciousCount = FHE.asEuint32(0);
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        Batch storage batch = batches[currentBatchId];
        if (!batch.active) revert InvalidBatch();
        batch.active = false;
        emit BatchClosed(currentBatchId, batch.transactionCount);

        if (batch.transactionCount > 0) {
            bytes32[] memory cts = new bytes32[](4);
            cts[0] = FHE.toBytes32(batch.encryptedTotalValue);
            cts[1] = FHE.toBytes32(batch.encryptedMaxValue);
            cts[2] = FHE.toBytes32(batch.encryptedMinValue);
            cts[3] = FHE.toBytes32(batch.encryptedSuspiciousCount);

            bytes32 stateHash = _hashCiphertexts(cts);
            uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
            decryptionContexts[requestId] = DecryptionContext({ batchId: currentBatchId, stateHash: stateHash, processed: false });
            emit DecryptionRequested(requestId, currentBatchId);
        }
    }

    function analyzeTransaction(
        euint32 encryptedValue,
        euint32 encryptedRecipientScore,
        euint32 encryptedThreshold
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) revert CooldownActive();
        lastSubmissionTime[msg.sender] = block.timestamp;

        Batch storage batch = batches[currentBatchId];
        if (!batch.active) revert InvalidBatch();

        _initIfNeeded(encryptedValue);
        _initIfNeeded(encryptedRecipientScore);
        _initIfNeeded(encryptedThreshold);
        _initIfNeeded(batch.encryptedTotalValue);
        _initIfNeeded(batch.encryptedMaxValue);
        _initIfNeeded(batch.encryptedMinValue);
        _initIfNeeded(batch.encryptedSuspiciousCount);

        batch.encryptedTotalValue = FHE.add(batch.encryptedTotalValue, encryptedValue);
        batch.encryptedMaxValue = FHE.max(batch.encryptedMaxValue, encryptedValue);
        batch.encryptedMinValue = FHE.min(batch.encryptedMinValue, encryptedValue);

        ebool isSuspicious = FHE.ge(encryptedRecipientScore, encryptedThreshold);
        batch.encryptedSuspiciousCount = FHE.add(batch.encryptedSuspiciousCount, FHE.ite(isSuspicious, FHE.asEuint32(1), FHE.asEuint32(0)));

        batch.transactionCount++;
        emit TransactionAnalyzed(currentBatchId, batch.transactionCount);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        Batch storage batch = batches[decryptionContexts[requestId].batchId];
        if (!batch.active) revert InvalidBatch(); // Batch should have been closed

        // Rebuild cts for state verification
        bytes32[] memory cts = new bytes32[](4);
        cts[0] = FHE.toBytes32(batch.encryptedTotalValue);
        cts[1] = FHE.toBytes32(batch.encryptedMaxValue);
        cts[2] = FHE.toBytes32(batch.encryptedMinValue);
        cts[3] = FHE.toBytes32(batch.encryptedSuspiciousCount);

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        // Decode cleartexts in the same order as cts
        uint256 totalValue = abi.decode(cleartexts.slice(0, 32), (uint256));
        uint256 maxValue = abi.decode(cleartexts.slice(32, 32), (uint256));
        uint256 minValue = abi.decode(cleartexts.slice(64, 32), (uint256));
        uint256 suspiciousCount = abi.decode(cleartexts.slice(96, 32), (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, totalValue, maxValue, minValue, suspiciousCount);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) internal {
        if (!FHE.isInitialized(val)) FHE.init(val);
    }

    function _requireInitialized(euint32 val) internal view {
        if (!FHE.isInitialized(val)) revert("NotInitialized");
    }
}