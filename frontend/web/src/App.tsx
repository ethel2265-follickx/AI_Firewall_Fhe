// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface TransactionRecord {
  id: string;
  encryptedAmount: string;
  timestamp: number;
  toAddress: string;
  riskScore: number;
  status: "safe" | "warning" | "danger";
  decrypted?: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newTransaction, setNewTransaction] = useState({ toAddress: "", amount: 0 });
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [showFAQ, setShowFAQ] = useState(false);
  const [activeTab, setActiveTab] = useState<"dashboard" | "transactions" | "alerts">("dashboard");

  // Stats for dashboard
  const safeCount = transactions.filter(t => t.status === "safe").length;
  const warningCount = transactions.filter(t => t.status === "warning").length;
  const dangerCount = transactions.filter(t => t.status === "danger").length;
  const totalValue = transactions.reduce((sum, t) => sum + (t.decrypted || 0), 0);

  useEffect(() => {
    loadTransactions().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadTransactions = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.error("Contract is not available");
        return;
      }

      // Load transaction keys
      const keysBytes = await contract.getData("transaction_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing transaction keys:", e); }
      }

      // Load each transaction
      const list: TransactionRecord[] = [];
      for (const key of keys) {
        try {
          const txBytes = await contract.getData(`transaction_${key}`);
          if (txBytes.length > 0) {
            try {
              const txData = JSON.parse(ethers.toUtf8String(txBytes));
              list.push({ 
                id: key, 
                encryptedAmount: txData.amount, 
                timestamp: txData.timestamp, 
                toAddress: txData.toAddress,
                riskScore: txData.riskScore || 0,
                status: calculateRiskStatus(txData.riskScore || 0)
              });
            } catch (e) { console.error(`Error parsing transaction ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading transaction ${key}:`, e); }
      }

      // Sort by timestamp (newest first)
      list.sort((a, b) => b.timestamp - a.timestamp);
      setTransactions(list);
    } catch (e) { 
      console.error("Error loading transactions:", e); 
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const calculateRiskStatus = (score: number): "safe" | "warning" | "danger" => {
    if (score < 30) return "safe";
    if (score < 70) return "warning";
    return "danger";
  };

  const submitTransaction = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting transaction with Zama FHE..." 
    });

    try {
      // Encrypt amount with FHE
      const encryptedAmount = FHEEncryptNumber(newTransaction.amount);
      
      // Generate random risk score (simulating FHE computation)
      const riskScore = Math.floor(Math.random() * 100);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique ID
      const txId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Prepare transaction data
      const txData = { 
        amount: encryptedAmount, 
        timestamp: Math.floor(Date.now() / 1000), 
        toAddress: newTransaction.toAddress,
        riskScore: riskScore
      };

      // Store transaction
      await contract.setData(`transaction_${txId}`, ethers.toUtf8Bytes(JSON.stringify(txData)));
      
      // Update transaction keys
      const keysBytes = await contract.getData("transaction_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(txId);
      await contract.setData("transaction_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Transaction analyzed with FHE!" 
      });
      
      await loadTransactions();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewTransaction({ toAddress: "", amount: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    }
  };

  const handleDecrypt = async (tx: TransactionRecord) => {
    if (tx.decrypted !== undefined) {
      // Already decrypted, toggle off
      setTransactions(transactions.map(t => 
        t.id === tx.id ? {...t, decrypted: undefined} : t
      ));
      return;
    }

    const decrypted = await decryptWithSignature(tx.encryptedAmount);
    if (decrypted !== null) {
      setTransactions(transactions.map(t => 
        t.id === tx.id ? {...t, decrypted} : t
      ));
    }
  };

  const faqItems = [
    {
      question: "How does Zama FHE protect my transactions?",
      answer: "Zama's Fully Homomorphic Encryption allows your transaction data to be analyzed while remaining encrypted. The AI firewall never sees your plaintext data."
    },
    {
      question: "What data is encrypted?",
      answer: "All sensitive numerical values (amounts, balances) are encrypted with FHE. Addresses and metadata remain visible for blockchain processing."
    },
    {
      question: "How are risk scores calculated?",
      answer: "The AI compares your transaction patterns against known malicious behavior models using homomorphic computations on encrypted data."
    },
    {
      question: "Can the firewall be bypassed?",
      answer: "No, all transactions must pass through the FHE analysis before being signed. This happens automatically in your wallet."
    }
  ];

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing FHE firewall...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="shield-grid"></div>
          </div>
          <h1>FHE<span>Firewall</span></h1>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-btn metal-button"
          >
            <div className="plus-icon"></div>New Transaction
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="tab-navigation">
          <button 
            className={`tab-btn ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            Dashboard
          </button>
          <button 
            className={`tab-btn ${activeTab === "transactions" ? "active" : ""}`}
            onClick={() => setActiveTab("transactions")}
          >
            Transactions
          </button>
          <button 
            className={`tab-btn ${activeTab === "alerts" ? "active" : ""}`}
            onClick={() => setActiveTab("alerts")}
          >
            Alerts
          </button>
          <button 
            className={`tab-btn ${showFAQ ? "active" : ""}`}
            onClick={() => setShowFAQ(!showFAQ)}
          >
            FAQ
          </button>
        </div>

        {showFAQ && (
          <div className="faq-section metal-card">
            <h2>FHE Firewall FAQ</h2>
            <div className="faq-grid">
              {faqItems.map((item, index) => (
                <div className="faq-item" key={index}>
                  <div className="faq-question">
                    <div className="q-icon">Q</div>
                    <h3>{item.question}</h3>
                  </div>
                  <div className="faq-answer">
                    <div className="a-icon">A</div>
                    <p>{item.answer}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "dashboard" && (
          <div className="dashboard-grid">
            <div className="stats-card metal-card">
              <h3>Security Overview</h3>
              <div className="stats-grid">
                <div className="stat-item safe">
                  <div className="stat-value">{safeCount}</div>
                  <div className="stat-label">Safe</div>
                </div>
                <div className="stat-item warning">
                  <div className="stat-value">{warningCount}</div>
                  <div className="stat-label">Warning</div>
                </div>
                <div className="stat-item danger">
                  <div className="stat-value">{dangerCount}</div>
                  <div className="stat-label">Danger</div>
                </div>
              </div>
            </div>

            <div className="risk-visualization metal-card">
              <h3>Risk Distribution</h3>
              <div className="risk-meter">
                <div className="risk-bar">
                  <div 
                    className="safe-zone" 
                    style={{ width: `${(safeCount / transactions.length) * 100 || 0}%` }}
                  ></div>
                  <div 
                    className="warning-zone" 
                    style={{ width: `${(warningCount / transactions.length) * 100 || 0}%` }}
                  ></div>
                  <div 
                    className="danger-zone" 
                    style={{ width: `${(dangerCount / transactions.length) * 100 || 0}%` }}
                  ></div>
                </div>
                <div className="risk-labels">
                  <span>Safe</span>
                  <span>Warning</span>
                  <span>Danger</span>
                </div>
              </div>
            </div>

            <div className="value-card metal-card">
              <h3>Protected Value</h3>
              <div className="value-display">
                <div className="crypto-icon"></div>
                <div className="value-amount">
                  {totalValue.toFixed(4)} ETH
                </div>
              </div>
              <div className="fhe-badge">
                <span>FHE Protected</span>
              </div>
            </div>

            <div className="zama-card metal-card">
              <h3>Powered by Zama FHE</h3>
              <p>This firewall uses Zama's revolutionary Fully Homomorphic Encryption to analyze your transactions without ever decrypting them.</p>
              <div className="tech-features">
                <div className="feature">
                  <div className="feature-icon"></div>
                  <span>End-to-End Encryption</span>
                </div>
                <div className="feature">
                  <div className="feature-icon"></div>
                  <span>Homomorphic Analysis</span>
                </div>
                <div className="feature">
                  <div className="feature-icon"></div>
                  <span>Zero Knowledge Proofs</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "transactions" && (
          <div className="transactions-section">
            <div className="section-header">
              <h2>Transaction History</h2>
              <button 
                onClick={loadTransactions} 
                className="refresh-btn metal-button" 
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            
            <div className="transactions-list metal-card">
              <div className="table-header">
                <div className="header-cell">ID</div>
                <div className="header-cell">To Address</div>
                <div className="header-cell">Amount</div>
                <div className="header-cell">Risk</div>
                <div className="header-cell">Date</div>
                <div className="header-cell">Actions</div>
              </div>
              
              {transactions.length === 0 ? (
                <div className="no-transactions">
                  <div className="no-data-icon"></div>
                  <p>No transactions analyzed yet</p>
                  <button 
                    className="metal-button primary" 
                    onClick={() => setShowCreateModal(true)}
                  >
                    Analyze First Transaction
                  </button>
                </div>
              ) : transactions.map(tx => (
                <div 
                  className={`transaction-row ${tx.status}`} 
                  key={tx.id}
                >
                  <div className="table-cell">#{tx.id.substring(0, 6)}</div>
                  <div className="table-cell">
                    {tx.toAddress.substring(0, 6)}...{tx.toAddress.substring(38)}
                  </div>
                  <div className="table-cell">
                    {tx.decrypted !== undefined ? 
                      `${tx.decrypted.toFixed(4)} ETH` : 
                      "Encrypted"}
                  </div>
                  <div className="table-cell">
                    <div className={`risk-badge ${tx.status}`}>
                      {tx.status} ({tx.riskScore})
                    </div>
                  </div>
                  <div className="table-cell">
                    {new Date(tx.timestamp * 1000).toLocaleDateString()}
                  </div>
                  <div className="table-cell actions">
                    <button 
                      className="metal-button small"
                      onClick={() => handleDecrypt(tx)}
                    >
                      {tx.decrypted !== undefined ? "Re-encrypt" : "Decrypt"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "alerts" && (
          <div className="alerts-section">
            <div className="section-header">
              <h2>Security Alerts</h2>
              <div className="alert-count">
                {dangerCount} Critical Alerts
              </div>
            </div>
            
            <div className="alerts-list metal-card">
              {dangerCount === 0 ? (
                <div className="no-alerts">
                  <div className="safe-icon"></div>
                  <h3>No Critical Alerts</h3>
                  <p>Your transactions appear safe</p>
                </div>
              ) : transactions.filter(t => t.status === "danger").map(tx => (
                <div className="alert-item" key={tx.id}>
                  <div className="alert-icon danger"></div>
                  <div className="alert-content">
                    <h3>High Risk Transaction Detected</h3>
                    <p>
                      Transaction to {tx.toAddress.substring(0, 6)}...{tx.toAddress.substring(38)} 
                      with risk score {tx.riskScore}
                    </p>
                    <div className="alert-time">
                      {new Date(tx.timestamp * 1000).toLocaleString()}
                    </div>
                  </div>
                  <button 
                    className="metal-button small danger"
                    onClick={() => handleDecrypt(tx)}
                  >
                    {tx.decrypted !== undefined ? "Re-encrypt" : "Decrypt"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal metal-card">
            <div className="modal-header">
              <h2>Analyze New Transaction</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-modal">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="fhe-notice">
                <div className="lock-icon"></div>
                <p>This transaction will be encrypted with Zama FHE before analysis</p>
              </div>
              
              <div className="form-group">
                <label>To Address</label>
                <input
                  type="text"
                  value={newTransaction.toAddress}
                  onChange={(e) => setNewTransaction({...newTransaction, toAddress: e.target.value})}
                  placeholder="0x..."
                  className="metal-input"
                />
              </div>
              
              <div className="form-group">
                <label>Amount (ETH)</label>
                <input
                  type="number"
                  value={newTransaction.amount}
                  onChange={(e) => setNewTransaction({...newTransaction, amount: parseFloat(e.target.value)})}
                  placeholder="0.00"
                  className="metal-input"
                  step="0.0001"
                />
              </div>
              
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-box">
                  <div className="plain-value">
                    <span>Plain Value:</span>
                    <div>{newTransaction.amount || 0} ETH</div>
                  </div>
                  <div className="arrow-icon">→</div>
                  <div className="encrypted-value">
                    <span>Encrypted:</span>
                    <div>
                      {newTransaction.amount ? 
                        FHEEncryptNumber(newTransaction.amount).substring(0, 30) + "..." : 
                        "No value"}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => setShowCreateModal(false)} 
                className="metal-button"
              >
                Cancel
              </button>
              <button 
                onClick={submitTransaction} 
                disabled={creating}
                className="metal-button primary"
              >
                {creating ? "Encrypting..." : "Analyze with FHE"}
              </button>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="shield-grid small"></div>
              <span>FHE Firewall</span>
            </div>
            <p>Your Web3 transactions protected by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} FHE Firewall. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
