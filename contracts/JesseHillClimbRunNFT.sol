// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title Jesse Hill Climb Run NFT
/// @notice Anyone can mint any run. TokenURI can contain self-contained or external metadata.
contract JesseHillClimbRunNFT is ERC721 {
  uint256 public nextTokenId = 1;

  struct RunData {
    uint256 meters;
    uint8 driverId;
  }

  // tokenId => run info
  mapping(uint256 => RunData) public runs;
  // tokenId => tokenURI
  mapping(uint256 => string) private _tokenURIs;

  event RunMinted(address indexed player, uint256 indexed tokenId, uint256 meters, uint8 driverId, string tokenURI);

  constructor() ERC721("Jesse Hill Climb", "JHC") {}

  /// @notice Mint a run NFT.
  /// @param meters Score in meters.
  /// @param driverId 0=Jesse, 1=Brian.
  /// @param tokenURI_ Metadata URI.
  function mintRun(uint256 meters, uint8 driverId, string calldata tokenURI_) external returns (uint256 tokenId) {
    tokenId = nextTokenId;
    nextTokenId = tokenId + 1;

    _safeMint(msg.sender, tokenId);

    runs[tokenId] = RunData({ meters: meters, driverId: driverId });
    _tokenURIs[tokenId] = tokenURI_;

    emit RunMinted(msg.sender, tokenId, meters, driverId, tokenURI_);
  }

  function tokenURI(uint256 tokenId) public view override returns (string memory) {
    require(_ownerOf(tokenId) != address(0), "NOT_MINTED");
    return _tokenURIs[tokenId];
  }
}
